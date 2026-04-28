import { useEffect, useRef } from 'react';

/**
 * Manages the SSE /api/events connection for planes-updated triggers and anomaly alerts.
 * Extracted from App.jsx to reduce God-component surface area.
 */
export function useAnomalyStream({ fetchPlanesRef, setAnomalyAlerts, playSquawkAlert }) {
    const seenAlertKeys = useRef(new Set());

    useEffect(() => {
        const es = new EventSource('/api/events');

        es.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.type === 'planes-updated') {
                    fetchPlanesRef.current?.();
                } else if (data.type === 'anomalies' && data.alerts?.length > 0) {
                    // Prune to prevent unbounded Set growth over long sessions
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

        // Browser auto-reconnects on error; log for visibility
        es.onerror = () => {
            console.warn('[SSE] Connection error — browser will auto-reconnect');
        };

        return () => es.close();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    // fetchPlanesRef, setAnomalyAlerts, playSquawkAlert are all stable refs/stable setters
}
