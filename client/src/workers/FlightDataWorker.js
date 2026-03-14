// [AERO-SYNC] Browser-friendly msgpack handling
import * as msgpack from 'msgpack-lite';

// Buffer polyfill for workers (msgpack-lite dependency)
if (typeof self !== 'undefined' && typeof self.Buffer === 'undefined') {
    self.Buffer = {
        isBuffer: () => false,
        from: (data) => new Uint8Array(data)
    };
}

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

        // Apply local state maintenance (Optional but good for fallback)
        removed.forEach(icao24 => {
            planesState.delete(icao24);
        });

        // Apply updates
        updates.forEach(u => {
            const icao24 = u[0];
            planesState.set(icao24, u); // Minimal storage
        });

        // [AERO-SYNC] 絕不重建 10,000 個物件。直接轉發 Delta 給主執行緒。
        // This avoids $O(N)$ CPU on worker and Structured Clone bloom in postMessage.
        notifyMain('PLANES_UPDATED', {
            updates,
            removed,
            globalTime: time,
            totalCount: planesState.size
        });
    }

    if (msg.type === 'telemetry') {
        notifyMain('TELEMETRY_UPDATED', msg);
    }
}

// Listen for messages from the main thread
self.onmessage = (event) => {
    const { type, payload } = event.data;

    switch (type) {
        case 'INIT':
            connectWebSocket(payload.baseUrl);
            break;
        case 'SET_VIEWPORT':
            if (ws && ws.readyState === WebSocket.OPEN) {
                // Use msgpack to encode the viewport message
                const encoded = msgpack.encode({
                    type: 'SET_VIEWPORT',
                    payload: payload // { lamin, lomin, lamax, lomax }
                });
                ws.send(encoded);
            }
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
