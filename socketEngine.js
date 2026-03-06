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

        // Send an initial full state marker to force the client to wait for the first full broadcast
        const initMsg = msgpack.encode({ type: 'init' });
        ws.send(initMsg);

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
 * Broadcast Delta Encoded Planes
 * @param {Array} states array of plane objects from parser
 * @param {number} timestamp
 */
function broadcastPlanes(states, timestamp) {
    if (!wss || wss.clients.size === 0) return;

    const currentIds = new Set();
    const updates = [];     // Planes that have changed or are new
    const removed = [];     // Planes that disappeared

    states.forEach(plane => {
        const { icao24, lat, lng, heading, altitude, velocity, onGround, category, isEmergency, callsign, vRate, squawk, lastContact } = plane;
        currentIds.add(icao24);

        const prev = prevStates.get(icao24);
        let changed = false;

        if (!prev) {
            changed = true;
        } else {
            // Delta Checks:
            // Lat/Lng > 0.0001 diff
            // Heading > 1 deg diff
            // Any other critical state change
            if (
                Math.abs(lat - prev.lat) > 0.0001 ||
                Math.abs(lng - prev.lng) > 0.0001 ||
                Math.abs(heading - prev.heading) > 1 ||
                prev.altitude !== altitude ||
                prev.velocity !== velocity ||
                prev.onGround !== onGround ||
                prev.lastContact !== lastContact
            ) {
                changed = true;
            }
        }

        if (changed) {
            // Store compressed version in updates array
            // Optimization: use array format instead of object to save bytes
            // Format: [icao24, lat, lng, heading, altitude, velocity, onGround, category, isEmergency, callsign, vRate, squawk, lastContact]
            updates.push([icao24, lat, lng, heading, altitude, velocity, onGround, category, isEmergency, callsign, vRate, squawk, lastContact]);

            prevStates.set(icao24, { lat, lng, heading, altitude, velocity, onGround, lastContact });
        }
    });

    // Detect removed planes
    for (const [icao24] of prevStates) {
        if (!currentIds.has(icao24)) {
            removed.push(icao24);
            prevStates.delete(icao24);
        }
    }

    if (updates.length > 0 || removed.length > 0) {
        const payload = msgpack.encode({
            type: 'delta',
            time: timestamp,
            updates,
            removed
        });

        // Broadcast to all clients
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }
}

module.exports = {
    initWebSocketServer,
    broadcastPlanes
};
