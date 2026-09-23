// Great-circle interpolation + antimeridian-safe polyline segmentation for
// the historical flight-trace replay feature (backed by
// GET /api/flight-trace/:hex — see backend/server.js).
//
// Deliberately self-contained and NOT shared with mapViewUtils.js's existing
// _greatCirclePoints/greatCirclePoints (used by the production Canvas live
// trail). That code renders every frame on the hot path for potentially
// thousands of planes; this one runs once per trace-replay request for a
// single selected aircraft. Keeping them separate means a change here can
// never regress the always-on live rendering.
//
// tar1090 reference algorithm (planeObject.js): don't draw a straight line
// between two points more than ~30km apart — interpolate along the great
// circle instead, since a straight lat/lon line and the real greatcircle
// path diverge visibly at long range. We use a larger threshold (500km)
// because at typical map zoom levels a straight chord under that distance
// is visually indistinguishable from the arc, so there's no point paying
// the extra vertices for short hops.

const EARTH_RADIUS_KM = 6371;
const GC_INTERP_THRESHOLD_KM = 500;
// Two adjacent points whose longitude differs by more than this can only be
// explained by a dateline (180°/-180°) crossing, not a real great-circle
// hop — max possible longitude delta along any true path segment we ever
// emit here is well under 180°, so 270° gives comfortable margin against
// floating-point edge cases right at the meridian.
const ANTIMERIDIAN_JUMP_DEG = 270;

function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Spherical linear interpolation (slerp) between two lat/lon points along
// the great circle connecting them. Returns `steps + 1` points including
// both endpoints.
function slerpPoints(lat1, lon1, lat2, lon2, steps) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const phi1 = toRad(lat1), lam1 = toRad(lon1);
    const phi2 = toRad(lat2), lam2 = toRad(lon2);
    const x1 = Math.cos(phi1) * Math.cos(lam1), y1 = Math.cos(phi1) * Math.sin(lam1), z1 = Math.sin(phi1);
    const x2 = Math.cos(phi2) * Math.cos(lam2), y2 = Math.cos(phi2) * Math.sin(lam2), z2 = Math.sin(phi2);
    const dot = Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2));
    const omega = Math.acos(dot);

    if (omega < 1e-9) return [[lat1, lon1], [lat2, lon2]];

    const sinOmega = Math.sin(omega);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = Math.sin((1 - t) * omega) / sinOmega;
        const b = Math.sin(t * omega) / sinOmega;
        const x = a * x1 + b * x2, y = a * y1 + b * y2, z = a * z1 + b * z2;
        pts.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
    }
    return pts;
}

/**
 * Turn a chronological list of {lat, lon} (or {lat, lng}) points into one
 * or more polyline segments — each an array of [lat, lng] pairs — ready to
 * feed straight into Leaflet, e.g.:
 *
 *   buildGreatCircleSegments(trace).forEach(seg => L.polyline(seg, {...}).addTo(map))
 *
 * Long hops (> GC_INTERP_THRESHOLD_KM) are replaced with great-circle
 * interpolated points instead of a straight chord. A dateline crossing
 * breaks the output into a new segment rather than drawing a line straight
 * across the map.
 */
export function buildGreatCircleSegments(points) {
    if (!Array.isArray(points) || points.length === 0) return [];

    const clean = points
        .map((p) => ({ lat: Number(p.lat), lon: Number(p.lon ?? p.lng) }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && !(p.lat === 0 && p.lon === 0));

    if (clean.length < 2) return [];

    const segments = [];
    let current = [[clean[0].lat, clean[0].lon]];

    const pushPoint = (lat, lon) => {
        const prev = current[current.length - 1];
        if (prev && Math.abs(lon - prev[1]) > ANTIMERIDIAN_JUMP_DEG) {
            if (current.length > 1) segments.push(current);
            current = [[lat, lon]];
        } else {
            current.push([lat, lon]);
        }
    };

    for (let i = 1; i < clean.length; i++) {
        const a = clean[i - 1];
        const b = clean[i];
        const distKm = haversineKm(a.lat, a.lon, b.lat, b.lon);

        if (distKm > GC_INTERP_THRESHOLD_KM) {
            const steps = Math.min(32, Math.max(2, Math.ceil(distKm / 200)));
            const interp = slerpPoints(a.lat, a.lon, b.lat, b.lon, steps);
            // interp[0] duplicates the point already at the tail of `current` — skip it.
            for (let j = 1; j < interp.length; j++) pushPoint(interp[j][0], interp[j][1]);
        } else {
            pushPoint(b.lat, b.lon);
        }
    }

    if (current.length > 1) segments.push(current);
    return segments;
}
