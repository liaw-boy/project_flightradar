/**
 * trailSpline.js — Flight trail processing pipeline
 *
 * Port of Aeris trail-cleanup.ts + trail-spline.ts + trail-altitude.ts
 * to vanilla JavaScript for AEROSTRAT.
 *
 * Source: https://github.com/kewonit/aeris (AGPL-3.0)
 *
 * Pipeline (applied per contiguous sub-path, gaps preserved):
 *   1. removeSpikePoints       — remove GPS glitch / MLAT U-turns
 *   2. removeDistanceOutliers  — RDP-based outlier removal
 *   3. roundSharpCorners3D     — pre-spline Bézier arc on sharp turns
 *   4. adaptiveDownsample      — cap point count before spline
 *   5. catmullRomSpline3D      — centripetal CR smooth interpolation
 *   6. smoothAltitudeProfile   — box-filter + rate-limiter on altitude
 *   7. removePathLoops         — post-spline self-intersection removal
 *
 * Main export:
 *   processTrailPath(rawPath) → cleanedPath
 *
 * AEROSTRAT track point format:
 *   [timestamp, lat, lng, altitude, heading, velocity, isLiveExtension?]
 *   indices:  0       1    2    3         4        5         6
 */

// ─── Catmull-Rom core ────────────────────────────────────────────────────────

const CR_ALPHA = 0.5;

function crKnot(ti, pi, pj) {
    const dx = pj[0] - pi[0], dy = pj[1] - pi[1], dz = pj[2] - pi[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!Number.isFinite(d2)) return ti + 1e-6;
    return ti + Math.pow(Math.max(d2, 1e-12), CR_ALPHA * 0.5);
}

function safeLerp(a, b, tA, tB, t) {
    const denom = tB - tA;
    if (Math.abs(denom) < 1e-12) return (a + b) * 0.5;
    return ((tB - t) / denom) * a + ((t - tA) / denom) * b;
}

function crSegmentPoint(P0, P1, P2, P3, t01) {
    const t0 = 0;
    const t1 = crKnot(t0, P0, P1);
    const t2 = crKnot(t1, P1, P2);
    const t3 = crKnot(t2, P2, P3);
    const t = t1 + t01 * (t2 - t1);
    const out = [0, 0, 0];
    for (let dim = 0; dim < 3; dim++) {
        const p0 = P0[dim], p1 = P1[dim], p2 = P2[dim], p3 = P3[dim];
        const A1 = safeLerp(p0, p1, t0, t1, t);
        const A2 = safeLerp(p1, p2, t1, t2, t);
        const A3 = safeLerp(p2, p3, t2, t3, t);
        const B1 = safeLerp(A1, A2, t0, t2, t);
        const B2 = safeLerp(A2, A3, t1, t3, t);
        const val = safeLerp(B1, B2, t1, t2, t);
        out[dim] = Number.isFinite(val) ? val : P1[dim] + t01 * (P2[dim] - P1[dim]);
    }
    return out;
}

function lerpPoint(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function reflectEndpoint(anchor, neighbour) {
    const dx = anchor[0] - neighbour[0];
    const dy = anchor[1] - neighbour[1];
    const dz = anchor[2] - neighbour[2];
    const dist = Math.sqrt(dx * dx + dy * dy);
    const MAX_REFLECT_DEG = 1.0;
    const scale = dist > MAX_REFLECT_DEG ? MAX_REFLECT_DEG / dist : 1.0;
    return [anchor[0] + dx * scale, anchor[1] + dy * scale, anchor[2] + dz * scale];
}

function segmentDensity(a, b, prevHeading, minPts, maxPts) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const avgLatRad = ((a[1] + b[1]) * 0.5 * Math.PI) / 180;
    const cosLat = Math.max(0.1, Math.cos(avgLatRad));
    const scaledDx = dx * cosLat;
    const dist = Math.sqrt(scaledDx * scaledDx + dy * dy);
    if (dist < 1e-9) return minPts;
    const heading = Math.atan2(scaledDx, dy);
    let curvatureFactor = 0;
    if (prevHeading !== null) {
        let delta = heading - prevHeading;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        curvatureFactor = Math.abs(delta) / Math.PI;
    }
    const distFactor = Math.min(1, dist / 2);
    const raw = minPts + (maxPts - minPts) * Math.max(distFactor, curvatureFactor);
    return Math.max(minPts, Math.min(maxPts, Math.round(raw)));
}

function deduplicatePoints(points) {
    if (points.length === 0) return points;
    const result = [];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        const alt = Number.isFinite(p[2]) ? p[2] : 0;
        if (result.length === 0) { result.push([p[0], p[1], alt]); continue; }
        const last = result[result.length - 1];
        const dx = p[0] - last[0], dy = p[1] - last[1];
        if (dx * dx + dy * dy < 1e-10) continue;
        result.push([p[0], p[1], alt]);
    }
    return result;
}

function catmullRomSplineCore(extended, startIdx, segCount, minPts, maxPts) {
    const result = [];
    let prevHeading = null;

    const headings = [];
    for (let i = 0; i < segCount - 1; i++) {
        const idx = startIdx + i;
        const P1 = extended[idx], P2 = extended[idx + 1];
        const avgLatRad = ((P1[1] + P2[1]) * 0.5 * Math.PI) / 180;
        const cosLat = Math.max(0.1, Math.cos(avgLatRad));
        headings.push(Math.atan2((P2[0] - P1[0]) * cosLat, P2[1] - P1[1]));
    }

    const STRAIGHT_THRESHOLD = (5 * Math.PI) / 180;
    const CURVE_THRESHOLD = (20 * Math.PI) / 180;

    for (let i = 0; i < segCount - 1; i++) {
        const idx = startIdx + i;
        const P0 = extended[idx - 1];
        const P1 = extended[idx];
        const P2 = extended[idx + 1];
        const P3 = extended[idx + 2];

        const nPts = segmentDensity(P1, P2, prevHeading, minPts, maxPts);

        const headingBefore = i > 0 ? headings[i - 1] : headings[i];
        const headingAfter = i < headings.length - 1 ? headings[i + 1] : headings[i];

        let deltaIn = headings[i] - headingBefore;
        if (deltaIn > Math.PI) deltaIn -= 2 * Math.PI;
        if (deltaIn < -Math.PI) deltaIn += 2 * Math.PI;
        let deltaOut = headingAfter - headings[i];
        if (deltaOut > Math.PI) deltaOut -= 2 * Math.PI;
        if (deltaOut < -Math.PI) deltaOut += 2 * Math.PI;

        const maxDelta = Math.max(Math.abs(deltaIn), Math.abs(deltaOut));
        const tension = maxDelta <= STRAIGHT_THRESHOLD ? 0.92
            : maxDelta >= CURVE_THRESHOLD ? 0.0
            : 0.92 * (1.0 - (maxDelta - STRAIGHT_THRESHOLD) / (CURVE_THRESHOLD - STRAIGHT_THRESHOLD));

        result.push(P1);
        for (let j = 1; j < nPts; j++) {
            const t = j / nPts;
            if (tension >= 0.98) {
                result.push(lerpPoint(P1, P2, t));
            } else if (tension <= 0.02) {
                result.push(crSegmentPoint(P0, P1, P2, P3, t));
            } else {
                const splineP = crSegmentPoint(P0, P1, P2, P3, t);
                const linearP = lerpPoint(P1, P2, t);
                result.push([
                    linearP[0] * tension + splineP[0] * (1 - tension),
                    linearP[1] * tension + splineP[1] * (1 - tension),
                    linearP[2] * tension + splineP[2] * (1 - tension),
                ]);
            }
        }
        prevHeading = headings[i];
    }
    result.push(extended[startIdx + segCount - 1]);
    return result;
}

export function catmullRomSpline3D(points, minPtsPerSeg = 6, maxPtsPerSeg = 28) {
    if (points.length < 2) return points.slice();
    const deduped = deduplicatePoints(points);
    if (deduped.length < 2) return deduped.slice();

    if (deduped.length === 2) {
        const out = [];
        for (let i = 0; i <= 8; i++) out.push(lerpPoint(deduped[0], deduped[1], i / 8));
        return out;
    }

    const virtual0 = reflectEndpoint(deduped[0], deduped[1]);
    const virtualN = reflectEndpoint(deduped[deduped.length - 1], deduped[deduped.length - 2]);
    const extended = [virtual0, ...deduped, virtualN];
    return catmullRomSplineCore(extended, 1, deduped.length, minPtsPerSeg, maxPtsPerSeg);
}

// ─── Spike removal ───────────────────────────────────────────────────────────

export function removeSpikePoints(path, altitudes, cosThreshold = -0.05) {
    if (path.length < 3) return { path, altitudes };

    const keep = new Array(path.length).fill(true);
    let removed = 0;

    // Pre-filter NaN/Infinity
    for (let i = 0; i < path.length; i++) {
        if (!Number.isFinite(path[i][0]) || !Number.isFinite(path[i][1])) {
            keep[i] = false; removed++;
        }
    }

    for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (let i = 1; i < path.length - 1; i++) {
            if (!keep[i]) continue;
            let pi = i - 1; while (pi >= 0 && !keep[pi]) pi--;
            if (pi < 0) continue;
            let ni = i + 1; while (ni < path.length && !keep[ni]) ni++;
            if (ni >= path.length) continue;

            const prev = path[pi], curr = path[i], next = path[ni];
            const dx1 = curr[0] - prev[0], dy1 = curr[1] - prev[1];
            const dx2 = next[0] - curr[0], dy2 = next[1] - curr[1];
            const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
            const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
            if (len1 < 1e-10 || len2 < 1e-10) continue;

            const cos = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
            if (cos < cosThreshold) { keep[i] = false; removed++; changed = true; continue; }
            if (cos < 0) {
                const ratio = Math.max(len1, len2) / Math.min(len1, len2);
                if (ratio > 4) { keep[i] = false; removed++; changed = true; }
            }
        }
        if (!changed) break;
    }

    if (removed === 0) return { path, altitudes };
    const newPath = [], newAlt = [];
    for (let i = 0; i < path.length; i++) {
        if (keep[i]) { newPath.push(path[i]); newAlt.push(altitudes[i] ?? null); }
    }
    return { path: newPath, altitudes: newAlt };
}

// ─── Distance outlier removal ────────────────────────────────────────────────

export function removeDistanceOutliers(path, altitudes, thresholdMultiplier = 3.0) {
    if (path.length < 5) return { path, altitudes };

    const segDists = [];
    for (let i = 1; i < path.length; i++) {
        const dx = path[i][0] - path[i - 1][0], dy = path[i][1] - path[i - 1][1];
        segDists.push(Math.sqrt(dx * dx + dy * dy));
    }
    const sorted = [...segDists].sort((a, b) => a - b);
    const medianDist = sorted[Math.floor(sorted.length / 2)];
    if (medianDist < 1e-8) return { path, altitudes };

    const threshold = medianDist * thresholdMultiplier;
    const keep = new Array(path.length).fill(true);
    let removed = 0;

    for (let pass = 0; pass < 2; pass++) {
        let changed = false;
        for (let i = 1; i < path.length - 1; i++) {
            if (!keep[i]) continue;
            let pi = i - 1; while (pi >= 0 && !keep[pi]) pi--;
            if (pi < 0) continue;
            let ni = i + 1; while (ni < path.length && !keep[ni]) ni++;
            if (ni >= path.length) continue;

            const prev = path[pi], curr = path[i], next = path[ni];
            const dx = next[0] - prev[0], dy = next[1] - prev[1];
            const lineLenSq = dx * dx + dy * dy;
            let perpDist;
            if (lineLenSq < 1e-12) {
                perpDist = Math.sqrt((curr[0] - prev[0]) ** 2 + (curr[1] - prev[1]) ** 2);
            } else {
                const t = Math.max(0, Math.min(1, ((curr[0] - prev[0]) * dx + (curr[1] - prev[1]) * dy) / lineLenSq));
                perpDist = Math.sqrt((curr[0] - prev[0] - t * dx) ** 2 + (curr[1] - prev[1] - t * dy) ** 2);
            }
            if (perpDist > threshold) { keep[i] = false; removed++; changed = true; }
        }
        if (!changed) break;
    }

    if (removed === 0) return { path, altitudes };
    const newPath = [], newAlt = [];
    for (let i = 0; i < path.length; i++) {
        if (keep[i]) { newPath.push(path[i]); newAlt.push(altitudes[i] ?? null); }
    }
    return { path: newPath, altitudes: newAlt };
}

// ─── Sharp corner rounding ───────────────────────────────────────────────────

export function roundSharpCorners3D(points, thresholdDeg = 20) {
    if (points.length < 3) return points;
    const thresholdRad = (thresholdDeg * Math.PI) / 180;
    const result = [points[0]];

    for (let i = 1; i < points.length - 1; i++) {
        const prev = points[i - 1], curr = points[i], next = points[i + 1];
        const distPrev = Math.sqrt((curr[0] - prev[0]) ** 2 + (curr[1] - prev[1]) ** 2);
        const distNext = Math.sqrt((next[0] - curr[0]) ** 2 + (next[1] - curr[1]) ** 2);
        if (distPrev < 5e-4 || distNext < 5e-4) { result.push(curr); continue; }

        const headingIn = Math.atan2(curr[0] - prev[0], curr[1] - prev[1]);
        const headingOut = Math.atan2(next[0] - curr[0], next[1] - curr[1]);
        let delta = headingOut - headingIn;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        const absDelta = Math.abs(delta);

        if (absDelta > thresholdRad) {
            const setback = Math.min(distPrev, distNext) * 0.45;
            const t1f = setback / distPrev;
            const T1 = [curr[0] + (prev[0] - curr[0]) * t1f, curr[1] + (prev[1] - curr[1]) * t1f, curr[2] + (prev[2] - curr[2]) * t1f];
            const t2f = setback / distNext;
            const T2 = [curr[0] + (next[0] - curr[0]) * t2f, curr[1] + (next[1] - curr[1]) * t2f, curr[2] + (next[2] - curr[2]) * t2f];
            const arcCount = Math.max(6, Math.min(14, Math.round((10 * absDelta) / Math.PI)));
            for (let j = 0; j <= arcCount; j++) {
                const t = j / arcCount, u = 1 - t;
                result.push([u*u*T1[0]+2*u*t*curr[0]+t*t*T2[0], u*u*T1[1]+2*u*t*curr[1]+t*t*T2[1], u*u*T1[2]+2*u*t*curr[2]+t*t*T2[2]]);
            }
        } else {
            result.push(curr);
        }
    }
    result.push(points[points.length - 1]);
    return result;
}

// ─── Adaptive downsampling (iterative RDP) ───────────────────────────────────

function perpendicularDistance(point, lineStart, lineEnd) {
    const avgLat = (((point[1] + lineStart[1] + lineEnd[1]) / 3) * Math.PI) / 180;
    const cosLat = Math.max(0.1, Math.cos(avgLat));
    const dx = (lineEnd[0] - lineStart[0]) * cosLat;
    const dy = lineEnd[1] - lineStart[1];
    const denom = dx * dx + dy * dy;
    const px = (point[0] - lineStart[0]) * cosLat;
    const py = point[1] - lineStart[1];
    if (denom < 1e-12) return Math.sqrt(px * px + py * py);
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / denom));
    return Math.sqrt((px - t * dx) ** 2 + (py - t * dy) ** 2);
}

function rdpSimplify(points, epsilon) {
    const n = points.length;
    if (n <= 2) return points.slice();
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length > 0) {
        const [start, end] = stack.pop();
        let maxDist = 0, maxIdx = start;
        for (let i = start + 1; i < end; i++) {
            const d = perpendicularDistance(points[i], points[start], points[end]);
            if (d > maxDist) { maxDist = d; maxIdx = i; }
        }
        if (maxDist > epsilon) {
            keep[maxIdx] = 1;
            if (maxIdx - start > 1) stack.push([start, maxIdx]);
            if (end - maxIdx > 1) stack.push([maxIdx, end]);
        }
    }
    const result = [];
    for (let i = 0; i < n; i++) { if (keep[i]) result.push(points[i]); }
    return result;
}

export function adaptiveDownsample(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    let lo = 0, hi = 5;
    let bestResult = points;
    for (let iter = 0; iter < 20; iter++) {
        const mid = (lo + hi) / 2;
        const result = rdpSimplify(points, mid);
        if (result.length <= maxPoints) { bestResult = result; hi = mid; }
        else lo = mid;
        if (Math.abs(result.length - maxPoints) < maxPoints * 0.05) break;
    }
    return bestResult;
}

// ─── Altitude smoothing ──────────────────────────────────────────────────────

export function smoothAltitudeProfile(altitudes, defaultAlt) {
    const safeDefault = Number.isFinite(defaultAlt) ? defaultAlt : 0;
    // Fill nulls
    const filled = altitudes.map(a => (a !== null && Number.isFinite(a) ? a : NaN));
    let lastValid = NaN;
    for (let i = 0; i < filled.length; i++) {
        if (!isNaN(filled[i])) lastValid = filled[i];
        else if (!isNaN(lastValid)) filled[i] = lastValid;
    }
    lastValid = NaN;
    for (let i = filled.length - 1; i >= 0; i--) {
        if (!isNaN(filled[i])) lastValid = filled[i];
        else if (!isNaN(lastValid)) filled[i] = lastValid;
    }
    const safe = filled.map(v => isNaN(v) ? safeDefault : v);
    if (safe.length < 4) return safe;

    // 5-pass box filter
    let current = safe;
    for (let pass = 0; pass < 5; pass++) {
        const next = [...current];
        for (let i = 1; i < current.length - 1; i++) {
            const val = current[i-1]*0.25 + current[i]*0.5 + current[i+1]*0.25;
            next[i] = Number.isFinite(val) ? val : current[i];
        }
        current = next;
    }

    // Bidirectional rate limiter
    const fwd = [...current];
    for (let pass = 0; pass < 3; pass++) {
        for (let i = 1; i < fwd.length; i++) {
            const delta = fwd[i] - fwd[i-1], abs = Math.abs(delta);
            if (abs > 200) fwd[i] = fwd[i-1] + Math.sign(delta) * (200 + (abs-200)*0.6);
        }
    }
    const bwd = [...current];
    for (let pass = 0; pass < 3; pass++) {
        for (let i = bwd.length - 2; i >= 0; i--) {
            const delta = bwd[i] - bwd[i+1], abs = Math.abs(delta);
            if (abs > 200) bwd[i] = bwd[i+1] + Math.sign(delta) * (200 + (abs-200)*0.6);
        }
    }
    const smoothed = current.map((_, i) => (fwd[i] + bwd[i]) / 2);
    smoothed[0] = current[0];
    smoothed[smoothed.length - 1] = current[current.length - 1];
    return smoothed;
}

// ─── Post-spline loop removal ────────────────────────────────────────────────

function segmentsIntersect(a1, a2, b1, b2) {
    const ax = a2[0]-a1[0], ay = a2[1]-a1[1];
    const bx = b2[0]-b1[0], by = b2[1]-b1[1];
    const denom = ax*by - ay*bx;
    if (Math.abs(denom) < 1e-15) return { hit: false, t: 0 };
    const cx = b1[0]-a1[0], cy = b1[1]-a1[1];
    const t = (cx*by - cy*bx) / denom;
    const u = (cx*ay - cy*ax) / denom;
    return { hit: t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99, t };
}

export function removePathLoops(path) {
    if (path.length < 8) return path;
    let result = path;
    const MAX_WINDOW = 500;
    for (let pass = 0; pass < 8; pass++) {
        let found = false;
        outer: for (let i = 0; i < result.length - 3; i++) {
            const maxJ = Math.min(i + MAX_WINDOW, result.length - 1);
            for (let j = i + 2; j < maxJ; j++) {
                const { hit, t } = segmentsIntersect(result[i], result[i+1], result[j], result[j+1]);
                if (hit) {
                    const ix = [
                        result[i][0] + t * (result[i+1][0] - result[i][0]),
                        result[i][1] + t * (result[i+1][1] - result[i][1]),
                        result[i][2] + t * (result[i+1][2] - result[i][2]),
                    ];
                    result = [...result.slice(0, i+1), ix, ...result.slice(j+1)];
                    found = true;
                    break outer;
                }
            }
        }
        if (!found) break;
    }
    return result;
}

// ─── Haversine helper (km) ───────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Run the full trail processing pipeline on a raw AEROSTRAT track.
 *
 * Input format:  [timestamp, lat, lng, altitude, heading, velocity, isLive?][]
 * Output format: same (with interpolated values for splined intermediate points)
 *
 * Gaps (time > 1800s or impossible jump > 50km in < 60s) are preserved —
 * the spline is applied within each contiguous sub-path only.
 *
 * The live extension point (index 6 = true) is always preserved as-is at
 * the end and is never splined.
 */
export function processTrailPath(rawPath) {
    if (!rawPath || rawPath.length < 2) return rawPath;

    // Separate live extension if present
    const lastPt = rawPath[rawPath.length - 1];
    const hasLive = !!lastPt[6];
    const workPath = hasLive ? rawPath.slice(0, -1) : rawPath;

    if (workPath.length < 2) return rawPath;

    // Split into contiguous sub-paths at gap boundaries
    const GAP_TIME   = 1800; // seconds — same as existing renderer
    const GAP_DIST   = 50;   // km
    const GAP_SPEED  = 2000; // km/h implied speed

    const subPaths = []; // array of { pts: rawPts, gapBefore: bool }
    let current = [workPath[0]];
    for (let i = 1; i < workPath.length; i++) {
        const prev = workPath[i - 1];
        const cur  = workPath[i];
        const dt   = (cur[0] && prev[0]) ? cur[0] - prev[0] : 0;
        const dist = haversineKm(prev[1], prev[2], cur[1], cur[2]);
        const spd  = dt > 0 ? (dist / dt) * 3600 : 0;
        const isGap = (dist > GAP_DIST && dt < 60 && spd > GAP_SPEED);
        if (isGap) {
            subPaths.push({ pts: current, gapBefore: subPaths.length > 0 });
            current = [cur];
        } else {
            current.push(cur);
        }
    }
    subPaths.push({ pts: current, gapBefore: subPaths.length > 0 });

    // Process each sub-path
    const output = [];
    for (const { pts, gapBefore } of subPaths) {
        if (pts.length < 2) {
            if (output.length > 0 || !gapBefore) output.push(...pts);
            else output.push(...pts);
            continue;
        }

        // Convert to ElevatedPoint [lng, lat, alt]
        let elevPts = pts.map(p => [p[2], p[1], p[3] ?? 0]);
        const alts  = pts.map(p => p[3] ?? null);

        // Step 1: Spike removal
        const s1 = removeSpikePoints(elevPts.map(p => [p[0], p[1]]), alts);
        // Rebuild elevPts from filtered indices
        elevPts = s1.path.map((p, i) => [p[0], p[1], s1.altitudes[i] ?? 0]);

        if (elevPts.length < 2) { output.push(...pts); continue; }

        // Step 2: Distance outlier removal
        const s2 = removeDistanceOutliers(elevPts.map(p => [p[0], p[1]]), elevPts.map(p => p[2]));
        elevPts = s2.path.map((p, i) => [p[0], p[1], s2.altitudes[i] ?? 0]);

        if (elevPts.length < 2) { output.push(...pts); continue; }

        // Step 3: Sharp corner rounding — REMOVED.
        // Root cause of "ellipse on straight line" bug:
        // ADS-B/MLAT position noise (100–1000m) creates apparent heading changes of
        // 10–20° between consecutive points on an actually-straight path.
        // roundSharpCorners3D at 20° threshold fires on almost every MLAT point,
        // inserting Bézier arc points that the CR spline then amplifies into visible
        // ellipses and loops. The CR spline already handles real turns naturally;
        // pre-rounding is redundant and harmful on noisy radar data.

        // Step 4: Adaptive downsampling (cap at 400 before spline)
        if (elevPts.length > 400) {
            elevPts = adaptiveDownsample(elevPts, 400);
        }

        // Step 5: Catmull-Rom spline
        // Reduced from (6, 20) → (3, 6): fewer interpolated points per segment.
        // The midpoint-quadratic renderer already smooths the output visually;
        // high interpolation counts amplified CR oscillations on noisy input data.
        elevPts = catmullRomSpline3D(elevPts, 3, 6);

        // Step 6: Altitude smoothing
        const smoothedAlts = smoothAltitudeProfile(elevPts.map(p => p[2]), 0);
        elevPts = elevPts.map((p, i) => [p[0], p[1], smoothedAlts[i]]);

        // Step 7: Loop removal
        elevPts = removePathLoops(elevPts);

        // Convert back to AEROSTRAT format
        // Interpolate timestamps, headings, velocities from original pts
        const origLen = pts.length;
        const splineLen = elevPts.length;
        const tsStart = pts[0][0] ?? 0;
        const tsEnd   = pts[origLen - 1][0] ?? 0;

        const splined = elevPts.map((ep, si) => {
            const frac = splineLen > 1 ? si / (splineLen - 1) : 0;
            // Find surrounding original points for heading/velocity interpolation
            const origFrac = frac * (origLen - 1);
            const oi = Math.min(Math.floor(origFrac), origLen - 2);
            const ot = origFrac - oi;
            const pA = pts[oi], pB = pts[oi + 1];

            const ts  = tsStart + frac * (tsEnd - tsStart);
            const lat = ep[1];
            const lng = ep[0];
            const alt = ep[2];

            // Heading interpolation (circular)
            const hA = pA[4] ?? 0, hB = pB[4] ?? hA;
            let dh = hB - hA;
            if (dh > 180) dh -= 360;
            if (dh < -180) dh += 360;
            const hdg = (hA + dh * ot + 360) % 360;

            const vel = (pA[5] ?? 0) + ((pB[5] ?? 0) - (pA[5] ?? 0)) * ot;

            return [ts, lat, lng, alt, hdg, vel];
        });

        output.push(...splined);
    }

    // Re-attach live extension
    if (hasLive) output.push(lastPt);

    return output;
}
