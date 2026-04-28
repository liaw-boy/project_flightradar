import { AIRCRAFT_CATALOG as paths, resolveTypecodeKey } from '../utils/aircraftIcons';

// ── 大圓弧插值（個人路線用）────────────────────────────────────────────────────
export function _greatCirclePoints(lat1, lng1, lat2, lng2, n = 64) {
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;
    const φ1 = toRad(lat1), λ1 = toRad(lng1);
    const φ2 = toRad(lat2), λ2 = toRad(lng2);
    const x1 = Math.cos(φ1)*Math.cos(λ1), y1 = Math.cos(φ1)*Math.sin(λ1), z1 = Math.sin(φ1);
    const x2 = Math.cos(φ2)*Math.cos(λ2), y2 = Math.cos(φ2)*Math.sin(λ2), z2 = Math.sin(φ2);
    const dot = Math.max(-1, Math.min(1, x1*x2 + y1*y2 + z1*z2));
    const Ω = Math.acos(dot);
    if (Ω < 0.001) return [[lat1, lng1], [lat2, lng2]];
    const sinΩ = Math.sin(Ω);
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const a = Math.sin((1-t)*Ω) / sinΩ;
        const b = Math.sin(t*Ω) / sinΩ;
        const x = a*x1 + b*x2, y = a*y1 + b*y2, z = a*z1 + b*z2;
        pts.push([toDeg(Math.atan2(z, Math.sqrt(x*x + y*y))), toDeg(Math.atan2(y, x))]);
    }
    return pts;
}

// Base icon size — PlaneFinder reference
export const FR24_BASE_PX = 36;

// ─── Haversine distance helper (km) ──────────────────────────────────────────
export function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Path2D Vector Object Cache (with ViewBox support) ──────────────
export const vectorPathsMap = new Map();
Object.entries(paths).forEach(([key, entry]) => {
    const vbArr = (entry.vb || "0 0 500 500").split(/\s+/).map(Number);
    vectorPathsMap.set(key, {
        path: new Path2D(entry.d),
        vb: vbArr
    });
});

// Module-level enrichment guard — persists across React re-renders
export const _enrichScheduled = new Set();

// ─── measureText cache — avoids redundant font measurement each frame ─────────
const _textWidthCache = new Map();
export function measureCached(ctx, text, font) {
    const key = font + '|' + text;
    const cached = _textWidthCache.get(key);
    if (cached !== undefined) return cached;
    ctx.font = font;
    const w = ctx.measureText(text).width;
    if (_textWidthCache.size > 2000) _textWidthCache.clear();
    _textWidthCache.set(key, w);
    return w;
}

// ─── Great Circle Arc Interpolation (tar1090-style) ──────────────────────────
export const GC_THRESHOLD_KM = 500;
export function greatCirclePoints(lat1, lng1, lat2, lng2, distKm) {
    const steps = Math.min(16, Math.ceil(distKm / 200));
    if (steps < 2) return [[lat1, lng1], [lat2, lng2]];
    const φ1 = lat1 * Math.PI / 180, λ1 = lng1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180, λ2 = lng2 * Math.PI / 180;
    const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1);
    const sinφ2 = Math.sin(φ2), cosφ2 = Math.cos(φ2);
    const cosλd = Math.cos(λ2 - λ1);
    const d = Math.acos(Math.min(1, sinφ1 * sinφ2 + cosφ1 * cosφ2 * cosλd));
    if (d < 1e-9) return [[lat1, lng1], [lat2, lng2]];
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const A = Math.sin((1 - t) * d) / Math.sin(d);
        const B = Math.sin(t * d) / Math.sin(d);
        const x = A * cosφ1 * Math.cos(λ1) + B * cosφ2 * Math.cos(λ2);
        const y = A * cosφ1 * Math.sin(λ1) + B * cosφ2 * Math.sin(λ2);
        const z = A * sinφ1 + B * sinφ2;
        const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
        const λ = Math.atan2(y, x);
        pts.push([φ * 180 / Math.PI, (λ * 180 / Math.PI + 540) % 360 - 180]);
    }
    return pts;
}

export const RENDER_MODE_FULL = 0;
export const RENDER_MODE_SIMPLE = 1;

export const getAircraftVectorKey = (plane) => {
    if (plane.icon_type) {
        const k = plane.icon_type.toUpperCase();
        if (paths[k]) return k;
    }
    const tc = (plane._activeTypecode || plane.typecode || '').toUpperCase();
    if (tc && paths[tc]) return tc;
    return resolveTypecodeKey(tc, plane.category);
};
