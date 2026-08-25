'use strict';
// Broadcast cadence smoothing ─────────────────────────────────────────
// Tier 1 (global baseline) and Tier 2 (viewport overlay) each poll on their
// own independent 5s setInterval, unsynchronized with each other. Measured
// live: the resulting WebSocket delta arrival gaps swing anywhere from
// ~300ms to ~6800ms for the same set of aircraft, cycle to cycle — trigger-
// based throttling (only enforcing a minimum gap) doesn't fix this, since
// the *maximum* gap is still whatever the two unsynchronized 5s pollers
// happen to leave between their broadcasts. The frontend derives its
// interpolation duration from that arrival gap, so the same physical
// movement gets animated over a 0.3s window one moment and a 6s+ window the
// next; when two broadcasts land close together, the prior animation hasn't
// finished before the next target arrives, which reads visually as the
// plane snapping backward. The fix is a real fixed-cadence ticker, fully
// decoupled from when either tier happens to fire: pruneAndBroadcast() only
// marks state dirty; a separate setInterval flushes on a constant rhythm.
// This fixes the delivery-side half of the "忽快忽慢/前進倒退" symptom;
// isPositionUpdateTrustworthy() (services/stateMerge.js) fixes the data-side half.
const { broadcastPlanes } = require('../socketEngine');
const { masterStateMap, getGlobalPlanesCache, setGlobalPlanesCache } = require('../state/appState');

const PLANE_TTL_MS = 90_000;       // 90s without update → remove from map
const BROADCAST_INTERVAL_MS = 2000;
let _broadcastDirty = false;

function pruneAndBroadcast() {
    // Pruning + globalPlanesCache stay immediate — HTTP polling (/api/planes/bbox)
    // and other in-process consumers should never see stale-by-design data.
    const cutoff = Date.now() - PLANE_TTL_MS;
    for (const [id, p] of masterStateMap) {
        if ((p._lastSeen || 0) < cutoff) masterStateMap.delete(id);
    }
    const states = Array.from(masterStateMap.values());
    setGlobalPlanesCache({ states, time: Math.floor(Date.now() / 1000), stale: false });
    _broadcastDirty = true; // picked up by the flush ticker below
}

function startBroadcastTicker() {
    return setInterval(() => {
        if (!_broadcastDirty) return;
        _broadcastDirty = false;
        broadcastPlanes(getGlobalPlanesCache().states, getGlobalPlanesCache().time);
    }, BROADCAST_INTERVAL_MS);
}

module.exports = { PLANE_TTL_MS, pruneAndBroadcast, startBroadcastTicker };
