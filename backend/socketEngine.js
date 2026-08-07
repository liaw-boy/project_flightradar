const WebSocket = require('ws');
const msgpack = require('msgpack-lite');
const logger = require('./logger');

let wss;
// icao24 -> { lat, lng, heading, altitude, velocity, onGround, lastContact, tuple }
// `tuple` is the full 14-field wire row, kept alongside the diffing fields so
// a bbox snapshot (new connection / viewport pan) can be served straight from
// this map without recomputing anything.
const prevStates = new Map();
let broadcastCount = 0; // [LOG] rolling counter for throttled log output

function buildTuple(plane) {
    return [
        plane.icao24, plane.lat, plane.lng, plane.heading, plane.altitude,
        plane.velocity, plane.onGround, plane.category, plane.isEmergency,
        plane.callsign, plane.vRate, plane.squawk, plane.lastContact,
        plane.typecode || null
    ];
}

function inBbox(bbox, lat, lng) {
    return !bbox || (
        lat >= bbox.lamin && lat <= bbox.lamax &&
        lng >= bbox.lomin && lng <= bbox.lomax
    );
}

// Send every currently-known plane inside a client's bbox as a one-off delta.
function sendBboxSnapshot(client) {
    if (client.readyState !== 1 /* OPEN */) return;
    const updates = [];
    for (const [, entry] of prevStates) {
        if (inBbox(client.bbox, entry.lat, entry.lng)) updates.push(entry.tuple);
    }
    if (updates.length === 0) return;
    const payload = msgpack.encode({
        type: 'delta',
        time: Math.floor(Date.now() / 1000),
        updates,
        removed: [],
    });
    try { client.send(payload); } catch (_) { /* client disconnected mid-send */ }
}

/**
 * Initialize WebSocket Server
 */
function initWebSocketServer(server) {
    // maxPayload caps a single incoming frame — client only ever sends small
    // viewport/selection messages, so 64KB is generous headroom against
    // memory-exhaustion abuse of the unauthenticated /ws endpoint.
    wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 64 * 1024 });

    wss.on('connection', (ws) => {
        logger.info('WS', `Client connected — total: ${wss.clients.size}`);

        // Default BBox: Global (very inclusive)
        ws.bbox = null;

        // Send an initial full state marker to force the client to wait for the first full broadcast
        const initMsg = msgpack.encode({ type: 'init' });
        try { ws.send(initMsg); } catch (_) { /* client disconnected before init */ }

        // Which ICAO24 this client has selected (for track_point push)
        ws.selectedIcao24 = null;

        ws.on('message', (data) => {
            try {
                const msg = msgpack.decode(new Uint8Array(data));
                if (msg.type === 'SET_VIEWPORT') {
                    ws.bbox = msg.payload;
                    logger.debug('WS', `Viewport set: lamin=${ws.bbox.lamin?.toFixed(2)} lamax=${ws.bbox.lamax?.toFixed(2)} lomin=${ws.bbox.lomin?.toFixed(2)} lomax=${ws.bbox.lomax?.toFixed(2)}`);
                    // Deltas only cover planes whose state changed since the last
                    // broadcast. A plane parked or holding steady in an area the
                    // client just panned into never "changes" again, so without
                    // this it stays invisible until it moves >~11m. Send every
                    // known plane in the new bbox once, as a synthetic delta.
                    sendBboxSnapshot(ws);
                } else if (msg.type === 'SELECT_PLANE') {
                    ws.selectedIcao24 = msg.icao24 || null;
                    logger.debug('WS', `Client selected plane: ${ws.selectedIcao24 || '(none)'}`);
                }
            } catch (err) {
                logger.error('WS', `Message handling error: ${err.message}`);
            }
        });

        ws.on('close', () => {
            logger.info('WS', `Client disconnected — total: ${wss.clients.size}`);
        });

        ws.on('error', (err) => {
            logger.error('WS', `Connection error: ${err.message}`);
        });
    });
}

/**
 * Broadcast Delta Encoded Planes (with Spatial Filtering)
 * @param {Array} states array of plane objects from parser
 * @param {number} timestamp
 */
function broadcastPlanes(states, timestamp) {
    if (!wss || wss.clients.size === 0) return;

    // 1. Pre-calculate deltas for all changed planes
    const updatesMap = new Map(); // icao24 -> update array
    const currentIds = new Set();
    const removed = [];

    for (let i = 0; i < states.length; i++) {
        const plane = states[i];
        const icao24 = plane.icao24;
        currentIds.add(icao24);

        const prev = prevStates.get(icao24);
        let changed = false;

        if (
            !prev ||
            Math.abs(plane.lat - prev.lat) > 0.0001 ||
            Math.abs(plane.lng - prev.lng) > 0.0001 ||
            Math.abs(plane.heading - prev.heading) > 1 ||
            prev.altitude !== plane.altitude ||
            prev.velocity !== plane.velocity ||
            prev.onGround !== plane.onGround ||
            prev.lastContact !== plane.lastContact
        ) {
            changed = true;
        }

        // Always refresh — even unchanged planes must stay current so a
        // later viewport pan can snapshot them accurately.
        const tuple = buildTuple(plane);
        prevStates.set(icao24, {
            lat: plane.lat, lng: plane.lng, heading: plane.heading,
            altitude: plane.altitude, velocity: plane.velocity,
            onGround: plane.onGround, lastContact: plane.lastContact,
            tuple,
        });

        if (changed) updatesMap.set(icao24, tuple);
    }

    // 2. Detect removed planes
    for (const [icao24] of prevStates) {
        if (!currentIds.has(icao24)) {
            removed.push(icao24);
            prevStates.delete(icao24);
        }
    }

    // 3. Targeted Broadcast (Spatial Filtering)
    wss.clients.forEach(client => {
        if (client.readyState !== 1 /* WebSocket.OPEN */) return;

        const clientUpdates = [];
        const clientRemoved = [];

        // Check if aircraft is in client's BBox
        for (const [, update] of updatesMap) {
            if (inBbox(client.bbox, update[1], update[2])) clientUpdates.push(update);
        }

        // Removed planes: simple check (or can skip filtering for simplicity if small list)
        removed.forEach(id => {
            // We should ideally check if the plane WAS in the client's bbox before,
            // but for simplicity and safety, we send all removed signals.
            clientRemoved.push(id);
        });

        if (clientUpdates.length > 0 || clientRemoved.length > 0) {
            const payload = msgpack.encode({
                type: 'delta',
                time: timestamp,
                updates: clientUpdates,
                removed: clientRemoved
            });
            try { client.send(payload); } catch (_) { /* client disconnected mid-send */ }
        }
    });

    broadcastCount++;
    // Log broadcast stats every 30 cycles (~5 min at 10s interval)
    if (broadcastCount % 30 === 1) {
        const totalChanged = updatesMap.size;
        const totalRemoved = removed.length;
        const clients = wss.clients.size;
        logger.info('WS', `Broadcast #${broadcastCount} — changed: ${totalChanged}, removed: ${totalRemoved}, clients: ${clients}, total tracked: ${prevStates.size}`);
    }
}

/**
 * @param {Object} stats stats from apiStats
 * @param {number} nextFetchIn seconds until next fetch
 * @param {string} source active data source name (v10.0)
 */
function broadcastTelemetry(stats, nextFetchIn, source = 'Airplanes.Live') {
    if (!wss || wss.clients.size === 0) return;

    const payload = msgpack.encode({
        type: 'telemetry',
        totalApiHits: stats.totalCalls,
        nextFetchIn: nextFetchIn,
        source: source, // [v10.0] New field
        accounts: stats.accounts.map(acc => ({
            user: acc.user,
            remainingCredits: acc.remainingCredits, // [v4.3.6] Sync with Dashboard.jsx
            unlockTime: acc.unlockTime, // [v4.3.6] Restore cooldown timer display
            limited: acc.unlockTime && new Date(acc.unlockTime).getTime() > Date.now()
        }))
    });

    wss.clients.forEach(client => {
        if (client.readyState === 1 /* WebSocket.OPEN */) {
            try { client.send(payload); } catch (_) { /* client disconnected mid-send */ }
        }
    });
}

/**
 * Get all active viewports from connected clients
 */
function getActiveViewports() {
    const viewports = [];
    if (!wss) return viewports;
    wss.clients.forEach(client => {
        if (client.readyState === 1 && client.bbox) {
            viewports.push(client.bbox);
        }
    });
    return viewports;
}

/**
 * Get number of currently connected WebSocket clients
 */
function getClientCount() {
    return wss ? wss.clients.size : 0;
}

/**
 * Push a single track point to every client that has icao24 selected.
 * Format: [timestamp, lat, lng, altitude, heading, velocity]
 */
function broadcastTrackPoint(icao24, point) {
    if (!wss || wss.clients.size === 0) return;
    const payload = msgpack.encode({ type: 'track_point', icao24, point });
    wss.clients.forEach(client => {
        if (client.readyState === 1 /* OPEN */ && client.selectedIcao24 === icao24) {
            try { client.send(payload); } catch (_) { /* client disconnected */ }
        }
    });
}

module.exports = {
    initWebSocketServer,
    broadcastPlanes,
    broadcastTelemetry,
    broadcastTrackPoint,
    getActiveViewports,
    getClientCount
};
