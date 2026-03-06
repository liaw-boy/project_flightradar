import * as msgpack from 'msgpack-lite';

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_DELAY = 10000;

// The current consolidated state of all aircraft
const planesState = new Map();

// Helper to notify the main thread
function notifyMain(type, payload = null) {
    postMessage({ type, payload });
}

function connectWebSocket(baseUrl) {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
    console.log(`[Worker] Connecting to WebSocket: ${wsUrl}`);

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer'; // Crucial for msgpack

    ws.onopen = () => {
        console.log('[Worker] WebSocket connected.');
        reconnectDelay = 1000;
        notifyMain('WS_CONNECTED');
    };

    ws.onmessage = (event) => {
        try {
            // Because we set binaryType = 'arraybuffer', event.data is an ArrayBuffer
            if (event.data instanceof ArrayBuffer) {
                const data = new Uint8Array(event.data);
                const decoded = msgpack.decode(data);
                handleDecodedMessage(decoded);
            } else {
                console.warn('[Worker] Received non-binary WebSocket message (ignored)');
            }
        } catch (err) {
            console.error('[Worker] Error decoding msgpack payload:', err);
            notifyMain('WS_ERROR', 'Payload decode failed. Fallback triggered.');
        }
    };

    ws.onclose = (event) => {
        console.log(`[Worker] WebSocket closed. Reconnecting in ${reconnectDelay}ms...`);
        notifyMain('WS_DISCONNECTED');
        scheduleReconnect(baseUrl);
    };

    ws.onerror = (err) => {
        console.error('[Worker] WebSocket error observed.');
        ws.close();
    };
}

function scheduleReconnect(baseUrl) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        connectWebSocket(baseUrl);
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
}

function handleDecodedMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'init') {
        // Initial connection signal. Real data comes via delta.
        console.log('[Worker] Received init signal.');
        return;
    }

    if (msg.type === 'delta') {
        const { time, updates = [], removed = [] } = msg;

        // Apply removed
        removed.forEach(icao24 => {
            planesState.delete(icao24);
        });

        // Apply updates
        // Format: [icao24, lat, lng, heading, altitude, velocity, onGround, category, isEmergency, callsign, vRate, squawk, lastContact]
        updates.forEach(u => {
            const icao24 = u[0];
            planesState.set(icao24, {
                icao24: u[0],
                lat: u[1],
                lng: u[2],
                heading: u[3],
                altitude: u[4],
                velocity: u[5],
                onGround: u[6],
                category: u[7],
                isEmergency: u[8],
                callsign: u[9],
                vRate: u[10],
                squawk: u[11],
                lastContact: u[12]
            });
        });

        // Convert Map back to dictionary format for Main Thread
        const planesDict = {};
        for (const [key, value] of planesState.entries()) {
            planesDict[key] = value;
        }

        notifyMain('PLANES_UPDATED', {
            planesDict,
            globalTime: time,
            totalCount: planesState.size
        });
    }
}

// Listen for messages from the main thread
self.onmessage = (event) => {
    const { type, payload } = event.data;

    switch (type) {
        case 'INIT':
            connectWebSocket(payload.baseUrl);
            break;
        case 'DISCONNECT':
            if (ws) {
                ws.onclose = null; // Prevent reconnect
                ws.close();
                ws = null;
            }
            if (reconnectTimer) clearTimeout(reconnectTimer);
            break;
    }
};
