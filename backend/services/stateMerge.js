'use strict';
// Position arbitration + merge-into-masterStateMap for the fusion engine.
//
// Root cause of the "moves forward then snaps back" symptom users saw: Tier 1
// (global adsb.lol baseline, 5s) and Tier 2 (per-viewport airplanes.live/
// re-api overlay, 5s) both write the same icao24 into masterStateMap with no
// coordination — this was confirmed live by capturing 4 minutes of WS traffic
// and finding aircraft with two DIFFERENT positions reported for the same
// nominal second. Previously mergeStates() was pure last-writer-wins keyed
// only on server receive time (`now`), so whichever fetch happened to finish
// last on the event loop won, independent of which one actually measured the
// aircraft's position more recently. Track-point history inherited the same
// corruption, since ingestTrackPoints() reads straight out of this map.
//
// Two independent guards, because they catch different failure modes:
//  1. Monotonic posTime — rejects genuinely stale data that arrives late
//     (out-of-order delivery). Confirmed to fully eliminate that class.
//  2. Implied-speed sanity check — for updates that DO have a newer posTime,
//     catches two sources disagreeing about the same instant (same/adjacent
//     timestamp, different coordinates) by cross-checking the position delta
//     against the aircraft's own reported velocity. A pure timestamp check
//     can't order these away because they aren't actually out of order.
const { masterStateMap } = require('../state/appState');
const {
    isRealIcao24, isNonIcaoTarget, isValidTypecode, POSITION_FIELDS,
    getDistance, initialBearingDeg, angleDiffDeg,
} = require('../utils/planeGuards');

const IMPLIED_SPEED_FLOOR_MPS = 15; // below this, GPS/quantization noise alone can look "too fast" — don't flag
const IMPLIED_SPEED_RATIO = 3;      // implied speed must exceed 3x the aircraft's own reported speed to be rejected
const REVERSAL_MIN_DIST_M = 60;     // below this, bearing is too noisy to mean anything — don't flag
const REVERSAL_ANGLE_DEG = 120;     // displacement bearing vs reported heading disagreeing by more than this = reversal

function isPositionUpdateTrustworthy(existing, incoming) {
    if (!existing || typeof existing.lat !== 'number') return true; // first sighting — nothing to compare against
    const existingPosTime = existing.posTime;
    const incomingPosTime = incoming.posTime;
    if (existingPosTime == null || incomingPosTime == null) return true; // can't arbitrate without both timestamps

    if (incomingPosTime < existingPosTime) return false; // guard 1: older measurement — reject outright

    const dtSec = incomingPosTime - existingPosTime;
    if (dtSec <= 0) return true; // same instant, nothing to sanity-check against

    const distM = getDistance(existing.lat, existing.lng, incoming.lat, incoming.lng) * 1000;

    // Guard 2: does the aircraft's own reported heading agree with the direction
    // it apparently just moved? A real aircraft can't reverse course ~180° in a
    // few seconds — this is what actually flagged the "moves forward then snaps
    // back" symptom in production, catching cases a pure speed-ratio check missed
    // (two sources disagreeing by ~2km/3s implies ~690 m/s, which is still under
    // 3x a jet's own ~250 m/s cruise speed, so guard 3 alone let it through).
    if (distM > REVERSAL_MIN_DIST_M && !incoming.onGround) {
        const displacementBearing = initialBearingDeg(existing.lat, existing.lng, incoming.lat, incoming.lng);
        const reportedHeading = typeof incoming.heading === 'number' ? incoming.heading
            : (typeof existing.heading === 'number' ? existing.heading : null);
        if (reportedHeading != null && angleDiffDeg(displacementBearing, reportedHeading) > REVERSAL_ANGLE_DEG) {
            if (process.env.DEBUG_ARBITRATION) console.log(`[ARB-REJECT-BEARING] ${incoming.icao24} distM=${distM.toFixed(0)} dt=${dtSec.toFixed(1)}s bearing=${displacementBearing.toFixed(0)} heading=${reportedHeading.toFixed(0)}`);
            return false;
        }
    }

    // Guard 3: implied speed vastly exceeds the aircraft's own reported speed —
    // catches same-instant conflicts a pure timestamp check can't order away.
    const impliedMps = distM / dtSec;
    const reportedMps = typeof incoming.velocity === 'number' ? incoming.velocity
        : (typeof existing.velocity === 'number' ? existing.velocity : null);
    if (reportedMps != null && impliedMps > IMPLIED_SPEED_FLOOR_MPS && impliedMps > reportedMps * IMPLIED_SPEED_RATIO) {
        if (process.env.DEBUG_ARBITRATION) console.log(`[ARB-REJECT-SPEED] ${incoming.icao24} distM=${distM.toFixed(0)} dt=${dtSec.toFixed(1)}s impliedMps=${impliedMps.toFixed(0)} reportedMps=${reportedMps.toFixed(0)}`);
        return false;
    }
    return true;
}

function mergeStates(states, strategy = 'upsert') {
    const now = Date.now();
    for (const p of states) {
        if (!p.icao24 || typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
        // Sentinel addresses are not aircraft — drop before they reach the map.
        if (!isRealIcao24(p.icao24) && !isNonIcaoTarget(p.icao24)) continue;

        const existing = masterStateMap.get(p.icao24);
        let record = p;
        if (existing && !isPositionUpdateTrustworthy(existing, p)) {
            // Keep the trusted position; still let everything else (squawk,
            // callsign, enrichment fields) through from the new record.
            record = { ...p };
            for (const f of POSITION_FIELDS) record[f] = existing[f];
            record.posTime = existing.posTime;
        }

        // _lastSeen only proves "this icao24 was still in the upstream
        // response" — an upstream feed that keeps re-reporting the same
        // frozen coordinates (signal actually lost, but the source keeps
        // listing the aircraft) refreshes _lastSeen forever, so the 90s TTL
        // prune and the LSTM gap-fill trigger (both keyed on _lastSeen in
        // broadcastEngine.js) never fire — the plane just sits frozen
        // on-screen indefinitely. _posUpdatedAt only advances when posTime
        // itself advances past what we last recorded, i.e. a genuinely new
        // measurement arrived, not merely a repeated one.
        const posAdvanced = !existing || existing.posTime == null || record.posTime == null
            || record.posTime > existing.posTime;
        const posUpdatedAt = posAdvanced ? now : (existing?._posUpdatedAt ?? now);

        if (strategy === 'merge') {
            const merged = { ...existing, ...record, _lastSeen: now, _posUpdatedAt: posUpdatedAt };
            // Preserve richer metadata fields from existing if new record lacks them
            if (!p.description && existing?.description) merged.description = existing.description;
            if (!p.year        && existing?.year)        merged.year        = existing.year;
            if (!p.typecode    && existing?.typecode)    merged.typecode    = existing.typecode;
            if (!p.operator    && existing?.operator)    merged.operator    = existing.operator;
            if (!p.model       && existing?.model)       merged.model       = existing.model;
            // A missing heading must not render as "nose due north" — carry
            // the last known heading forward instead of letting it go null.
            if (merged.heading == null && typeof existing?.heading === 'number') merged.heading = existing.heading;
            masterStateMap.set(p.icao24, merged);
        } else {
            // 'upsert' (Tier 1) previously replaced the whole record wholesale
            // every 5s poll — raw ADS-B data has no operator/model field, so
            // enrichAndIngest()'s MictronicsDb-sourced operator/model got
            // silently wiped out on the very next baseline cycle, every cycle.
            // That's why the map-wide operator merge only ever showed ~21%
            // instead of Mictronics' actual ~80% hit rate against live
            // traffic: only whichever planes enrichAndIngest had *just*
            // touched, in the brief window before the next upsert, ever
            // showed it. Position/telemetry fields still come wholesale from
            // the new record (that data must always be fresh); only these
            // enrichment-only fields carry forward.
            const next = { ...record, _lastSeen: now, _posUpdatedAt: posUpdatedAt };
            if (!next.operator && existing?.operator) next.operator = existing.operator;
            if (!next.model    && existing?.model)    next.model    = existing.model;
            if (!isValidTypecode(next.typecode) && isValidTypecode(existing?.typecode)) next.typecode = existing.typecode;
            // A missing heading must not render as "nose due north" — carry
            // the last known heading forward instead of letting it go null.
            if (next.heading == null && typeof existing?.heading === 'number') next.heading = existing.heading;
            masterStateMap.set(p.icao24, next);
        }
    }
}

module.exports = { isPositionUpdateTrustworthy, mergeStates };
