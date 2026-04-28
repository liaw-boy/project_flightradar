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

// ─── Altitude Profile Mini-Chart (SVG) ────────────────────────────────────────
export function AltitudeChart({ history, icao24 }) {
    const data = history?.[icao24];
    if (!data || data.length < 2) return null;

    const points = data.slice(-60);
    const altitudes = points.map((p, i) => ({ x: i, alt: p[6] ? 0 : (p[3] || 0) }));
    const trueMax = Math.max(...altitudes.map(p => p.alt));
    if (trueMax < 10) return null;

    const maxAlt = Math.max(trueMax, 1000);
    const W = 220, H = 52;
    const xStep = W / Math.max(1, altitudes.length - 1);

    const pathD = altitudes.map((p, i) => {
        const x = i * xStep;
        const y = H - (p.alt / maxAlt) * (H - 4);
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const fillD = `${pathD} L ${W},${H} L 0,${H} Z`;

    return (
        <div style={{ margin: '14px 20px 4px 20px' }}>
            <div style={{ fontSize: 10, color: 'var(--color-text-dim)', marginBottom: 6, letterSpacing: 1, fontWeight: 700 }}>ALTITUDE PROFILE</div>
            <div style={{ position: 'relative', width: '100%', height: '52px', borderRadius: '6px', overflow: 'hidden', background: 'rgba(0,0,0,0.2)' }}>
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
                    <defs>
                        <linearGradient id={`altGrad-${icao24}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="rgba(34,211,238,0.4)" />
                            <stop offset="100%" stopColor="rgba(34,211,238,0)" />
                        </linearGradient>
                    </defs>
                    <path d={fillD} fill={`url(#altGrad-${icao24})`} />
                    <path d={pathD} fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeLinejoin="round" />
                    <text x="4" y="14" fill="rgba(255,255,255,0.7)" fontSize="10" fontFamily="JetBrains Mono, monospace" fontWeight="600">
                        {Math.round(maxAlt).toLocaleString()}ft
                    </text>
                </svg>
            </div>
        </div>
    );
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

// ─── Flight Progress Bar ───────────────────────────────────────────────────────
export function FlightProgress({ plane, depInfo, arrInfo }) {
    const progress = useMemo(() => {
        if (!depInfo?.lat || !arrInfo?.lat || !plane?.lat || !plane?.lng) return null;
        const total     = haversineKm(depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng);
        const done      = haversineKm(depInfo.lat, depInfo.lng, plane.lat, plane.lng);
        const remaining = haversineKm(plane.lat, plane.lng, arrInfo.lat, arrInfo.lng);
        const pct       = Math.max(2, Math.min(100, Math.round((done / total) * 100)));
        const etaMin    = plane.velocity > 0 ? Math.round((remaining * 1000) / plane.velocity / 60) : null;
        return { pct, remaining: Math.round(remaining), etaMin };
    }, [plane, depInfo, arrInfo]);

    if (!progress) return null;
    const { pct, remaining, etaMin } = progress;
    const etaStr = etaMin !== null && etaMin >= 0 ? `${Math.floor(etaMin / 60)}h ${etaMin % 60}min` : '--';

    return (
        <div className="flight-progress" style={{ margin: '14px 20px', padding: '10px 14px', background: 'var(--surface-hover)', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <div className="fp-header" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '11px', fontWeight: 600, color: 'var(--text-3)' }}>
                <span className="fp-pct" style={{ color: 'var(--accent)' }}>{pct}% complete</span>
                <span className="fp-eta" style={{ color: 'var(--text-3)' }}>ETA {etaStr} · {remaining}km</span>
            </div>
            <div className="fp-bar" style={{ position: 'relative', height: '6px', background: 'var(--border)', borderRadius: '3px' }}>
                <div className="fp-fill" style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, var(--accent), var(--accent-2))', borderRadius: '3px' }}>
                    <PlaneIcon size={14} className="fp-plane-dot" style={{ position: 'absolute', right: '-7px', top: '-4px', color: 'var(--accent)', filter: 'var(--accent-glow)', transform: 'rotate(90deg)' }} />
                </div>
            </div>
        </div>
    );
}
