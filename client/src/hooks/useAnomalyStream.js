import { useEffect, useRef, useState } from 'react';

/**
 * Manages the SSE /api/events connection for anomaly alerts.
 * Returns { sseStale } — true when BOTH SSE has been down for >20s AND WebSocket
 * has not delivered data in the last 15s. This prevents false "LIVE LOST" when
 * SSE hiccups but the WebSocket data channel is still healthy.
 *
 * @param {object} opts
 * @param {React.MutableRefObject} opts.fetchPlanesRef
 * @param {Function} opts.setAnomalyAlerts
 * @param {Function} opts.playSquawkAlert
 * @param {React.MutableRefObject<number>} [opts.wsAliveRef] — updated to Date.now() on each WS batch
 */
export function useAnomalyStream({ fetchPlanesRef, setAnomalyAlerts, playSquawkAlert, wsAliveRef }) {
    const seenAlertKeys = useRef(new Set());
    const [sseStale, setSseStale] = useState(false);
    const staleTimerRef = useRef(null);

    useEffect(() => {
        const es = new EventSource('/api/events');

        const clearStaleTimer = () => {
            if (staleTimerRef.current) {
                clearTimeout(staleTimerRef.current);
                staleTimerRef.current = null;
            }
        };

        es.onopen = () => {
            clearStaleTimer();
            setSseStale(false);
        };

        es.onmessage = (e) => {
            clearStaleTimer();
            setSseStale(false);
            try {
                const data = JSON.parse(e.data);
                if (data.type === 'heartbeat') return;
                if (data.type === 'planes-updated') {
                    fetchPlanesRef.current?.();
                } else if (data.type === 'anomalies' && data.alerts?.length > 0) {
                    if (seenAlertKeys.current.size > 500) seenAlertKeys.current.clear();

                    const newAlerts = data.alerts.filter(a => {
                        const key = `${a.icao24}-${a.type}`;
                        if (seenAlertKeys.current.has(key)) return false;
                        seenAlertKeys.current.add(key);
                        return true;
                    });
                    if (newAlerts.length > 0) {
                        const severity = newAlerts.some(a => a.severity === 'critical') ? 'critical' : 'warning';
                        playSquawkAlert(severity);
                    }
                    setAnomalyAlerts(prev => {
                        const merged = [...data.alerts, ...prev.filter(a =>
                            !data.alerts.some(b => b.icao24 === a.icao24 && b.type === a.type)
                        )].slice(0, 10);
                        return merged;
                    });
                }
            } catch (_) { /* ignore SSE parse error */ }
        };

        es.onerror = () => {
            // Show LIVE LOST only after 20s of sustained SSE disconnection (5s heartbeat × 3 misses
            // + buffer), AND only if the WebSocket data channel is also silent for >15s.
            // This prevents false positives when SSE hiccups but WS is still delivering plane data.
            if (!staleTimerRef.current) {
                staleTimerRef.current = setTimeout(() => {
                    staleTimerRef.current = null;
                    const wsAge = wsAliveRef ? Date.now() - (wsAliveRef.current || 0) : Infinity;
                    if (wsAge > 15000) {
                        setSseStale(true);
                    }
                    // If WS is alive, don't set stale — SSE dropped but data is still flowing
                }, 20000);
            }
        };

        return () => {
            clearStaleTimer();
            es.close();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return { sseStale };
}
