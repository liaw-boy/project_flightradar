'use strict';
// Shared in-memory state for the flight data fusion engine (three-tier
// polling → mergeStates → pruneAndBroadcast → /api/planes/bbox pipeline
// in server.js). Centralized here so any module can read/write the same
// instances instead of each closing over server.js's module scope.
//
// globalPlanesCache is the one exception that needs get/set accessors
// rather than a direct export: the fusion engine periodically replaces
// the whole object (`globalPlanesCache = {...}`), not just its fields,
// so a plain destructured reference would go stale after the first
// replacement. Everything else below (Maps/plain objects) is only ever
// mutated in place (.set/.clear/property assignment), so a direct
// reference stays valid for the life of the process.

const masterStateMap = new Map();  // icao24 → { ...state, _lastSeen: ms }
const sourceHealth = {};           // key → { cbUntil, consecutiveFails, lastOk, lastCount, lastLatency }
const airportSpatialGrid = new Map(); // key: 'lat_lng' -> [airport, ...]
const aircraftMetadataIndex = new Map(); // icao24 -> typecode
const lastGlobalStatesMap = new Map(); // icao24 -> state (用於偵測起飛/降落)
const activeSessions = new Map();  // [Flight Sessions] icao24 -> { sessionId, callsign, lastSeen, onGround }
const lastStoredPoint = new Map(); // [Track Dedup] icao24 -> { lat, lng, altitude, heading, velocity, ts }
const recentTrackBuffer = new Map(); // [Trajectory Predictor] icao24 -> last N airborne points (ring buffer, oldest first)
const pendingPredictions = new Map(); // [Prediction Log] icao24 -> { lat, lng, altitude, baselinePosUpdatedAt } — last not-yet-validated prediction
const notifiedEmergencies = new Set(); // [Discord Alert] icao24s already notified for their CURRENT emergency squawk — cleared when it clears
const notifiedMilitary = new Set(); // [Discord Alert] icao24s already notified as military for their CURRENT sighting — cleared when they leave masterStateMap
const notifiedSpecialLivery = new Set(); // [Discord Alert] icao24s already notified as special-livery for their CURRENT sighting — cleared when they leave masterStateMap
const ingestionStats = { totalPoints: 0, totalBatches: 0, sessionsCreated: 0, sessionsClosed: 0, lastBatchSize: 0, lastBatchMs: 0 };

let _globalPlanesCache = { states: [], time: 0 };
function getGlobalPlanesCache() { return _globalPlanesCache; }
function setGlobalPlanesCache(next) { _globalPlanesCache = next; }

module.exports = {
    masterStateMap,
    sourceHealth,
    airportSpatialGrid,
    aircraftMetadataIndex,
    lastGlobalStatesMap,
    activeSessions,
    lastStoredPoint,
    recentTrackBuffer,
    pendingPredictions,
    notifiedEmergencies,
    notifiedMilitary,
    notifiedSpecialLivery,
    ingestionStats,
    getGlobalPlanesCache,
    setGlobalPlanesCache,
};
