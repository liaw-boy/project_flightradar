import React, { useMemo } from 'react';
import { Plane as PlaneIcon } from 'lucide-react';

// ─── Haversine distance (km) ──────────────────────────────────────────────────
export function haversineKm(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Inline Progress (center column of boarding pass) ─────────────────────────
export function FlightProgressInline({ plane, depInfo, arrInfo }) {
    const progress = useMemo(() => {
        if (!depInfo?.lat || !arrInfo?.lat || !plane?.lat || !plane?.lng) return null;
        const total = haversineKm(depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng);
        const done  = haversineKm(depInfo.lat, depInfo.lng, plane.lat, plane.lng);
        const pct   = Math.max(2, Math.min(98, Math.round((done / total) * 100)));
        return { pct };
    }, [plane, depInfo, arrInfo]);

    if (!progress) return <PlaneIcon size={15} className="bp-arc-plane" style={{ transform: 'rotate(90deg)' }} />;
    const { pct } = progress;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: '100%', paddingTop: 22 }}>
            <span style={{ fontSize: 11, fontWeight: 900, color: 'var(--accent)', letterSpacing: 0.5 }}>{pct}%</span>
            <div style={{ position: 'relative', width: '100%', height: 5, background: 'var(--border)', borderRadius: 3 }}>
                <div style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, var(--accent), var(--accent-2))', borderRadius: 3, boxShadow: '0 0 4px var(--accent)' }} />
                <div style={{ position: 'absolute', top: '50%', left: `${pct}%`, transform: 'translate(-50%, -50%)' }}>
                    <PlaneIcon size={22} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 5px var(--accent))' }} />
                </div>
            </div>
        </div>
    );
}
