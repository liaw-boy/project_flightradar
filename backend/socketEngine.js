const WebSocket = require('ws');
const msgpack = require('msgpack-lite');

let wss;
const prevStates = new Map(); // icao24 -> state for delta encoding

/**
 * Initialize WebSocket Server
 */
function initWebSocketServer(server) {
    wss = new WebSocket.Server({ server, path: '/ws' });

    wss.on('connection', (ws) => {
        console.log(`🔌 [WS] Client connected. Total: ${wss.clients.size}`);

        // Default BBox: Global (very inclusive)
        ws.bbox = null;

        // Send an initial full state marker to force the client to wait for the first full broadcast
        const initMsg = msgpack.encode({ type: 'init' });
        try { ws.send(initMsg); } catch (_) { /* client disconnected before init */ }

        ws.on('message', (data) => {
            try {
                const msg = msgpack.decode(new Uint8Array(data));
                if (msg.type === 'SET_VIEWPORT') {
                    // payload: { lamin, lomin, lamax, lomax }
                    ws.bbox = msg.payload;
                    console.log(`🎯 [WS] Client viewport updated: ${JSON.stringify(ws.bbox)}`);
                }
            } catch (err) {
                console.error(`❌ [WS] Message handling error: ${err.message}`);
            }
        });

        ws.on('close', () => {
            console.log(`🔌 [WS] Client disconnected. Total: ${wss.clients.size}`);
        });

        // Handle error to prevent crashing
        ws.on('error', (err) => {
            console.error(`❌ [WS] Connection error: ${err.message}`);
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

        if (!prev) {
            changed = true;
            prevStates.set(icao24, {
                lat: plane.lat, lng: plane.lng, heading: plane.heading,
                altitude: plane.altitude, velocity: plane.velocity,
                onGround: plane.onGround, lastContact: plane.lastContact
            });
        } else if (
            Math.abs(plane.lat - prev.lat) > 0.0001 ||
            Math.abs(plane.lng - prev.lng) > 0.0001 ||
            Math.abs(plane.heading - prev.heading) > 1 ||
            prev.altitude !== plane.altitude ||
            prev.velocity !== plane.velocity ||
            prev.onGround !== plane.onGround ||
            prev.lastContact !== plane.lastContact
        ) {
            changed = true;
            prev.lat = plane.lat;
            prev.lng = plane.lng;
            prev.heading = plane.heading;
            prev.altitude = plane.altitude;
            prev.velocity = plane.velocity;
            prev.onGround = plane.onGround;
            prev.lastContact = plane.lastContact;
        }

        if (changed) {
            updatesMap.set(icao24, [
                icao24, plane.lat, plane.lng, plane.heading, plane.altitude,
                plane.velocity, plane.onGround, plane.category, plane.isEmergency,
                plane.callsign, plane.vRate, plane.squawk, plane.lastContact,
                plane.typecode || null
            ]);
        }
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
        for (const [icao24, update] of updatesMap) {
            const lat = update[1];
            const lng = update[2];
            if (!client.bbox || (
                lat >= client.bbox.lamin && lat <= client.bbox.lamax &&
                lng >= client.bbox.lomin && lng <= client.bbox.lomax
            )) {
                clientUpdates.push(update);
            }
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
}

/**
 * Broadcast Backend Telemetry (API Hits, Quota, Countdown)
 * @param {Object} stats stats from apiStats
 * @param {number} nextFetchIn seconds until next fetch
 */
function broadcastTelemetry(stats, nextFetchIn) {
    if (!wss || wss.clients.size === 0) return;

    const payload = msgpack.encode({
        type: 'telemetry',
        totalApiHits: stats.totalCalls,
        nextFetchIn: nextFetchIn,
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

module.exports = {
    initWebSocketServer,
    broadcastPlanes,
    broadcastTelemetry,
    getActiveViewports
};
