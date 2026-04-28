import { useEffect, useRef, useState } from 'react';

/**
 * Manages the SSE /api/events connection for planes-updated triggers and anomaly alerts.
 * Returns { sseStale } — true when the connection has been down for >8s (ignores brief reconnects).
 */
export function useAnomalyStream({ fetchPlanesRef, setAnomalyAlerts, playSquawkAlert }) {
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
            // Only show stale warning after 8s of sustained disconnection.
            // Browser auto-reconnect fires onerror briefly — this debounce avoids false positives.
            if (!staleTimerRef.current) {
                staleTimerRef.current = setTimeout(() => {
                    setSseStale(true);
                    staleTimerRef.current = null;
                }, 8000);
            }
        };

        return () => {
            clearStaleTimer();
            es.close();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return { sseStale };
}
