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
    ingestionStats,
    getGlobalPlanesCache,
    setGlobalPlanesCache,
};
