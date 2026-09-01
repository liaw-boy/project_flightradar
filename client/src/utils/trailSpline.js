/**
 * trailSpline.js — Flight trail processing entry point
 *
 * AEROSTRAT track point format:
 *   [timestamp, lat, lng, altitude, heading, velocity, isLiveExtension?]
 *   indices:  0       1    2    3         4        5         6
 *
 * History: this used to be a full port of Aeris's trail-cleanup/spline/
 * altitude pipeline (spike removal, RDP outlier removal, Catmull-Rom
 * smoothing, loop removal — source: https://github.com/kewonit/aeris,
 * AGPL-3.0) designed for noisy MLAT data (~km errors). On clean ADS-B data
 * (adsb.fi/adsb.lol, ~10m accuracy) that pipeline produced visible
 * overshoots and phantom detours instead of improving the path, so it was
 * disabled down to just NaN/duplicate filtering. The disabled pipeline
 * functions (removeSpikePoints, catmullRomSpline3D, etc.) were removed
 * entirely rather than left as dead exports — see git history if the full
 * pipeline is ever needed again for a noisier data source.
 */

/**
 * Process raw AEROSTRAT track for display.
 *
 * Input format:  [timestamp, lat, lng, altitude, heading, velocity, isLive?][]
 * Output format: same
 *
 * The renderer (MapView.jsx) already handles gap detection, bridging, and
 * per-segment coloring. This function only filters invalid coordinates and
 * removes exact duplicate consecutive positions.
 */
export function processTrailPath(rawPath) {
    if (!rawPath || rawPath.length < 2) return rawPath ?? [];

    const out = [];
    let prevLat = null, prevLng = null;

    for (const p of rawPath) {
        const lat = p[1], lng = p[2];
        // Drop NaN / non-finite coordinates
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        // Drop exact consecutive duplicates (parked aircraft transponder jitter)
        if (lat === prevLat && lng === prevLng) continue;
        out.push(p);
        prevLat = lat;
        prevLng = lng;
    }

    return out;
}
