/**
 * flightWorker.js — Off-Thread Flight Data Engine
 *
 * Responsibilities (ALL off main thread):
 *   1. WebSocket connection + msgpack binary decode
 *   2. Array→Object conversion for each delta update
 *   3. Consolidated state management (Map of all planes)
 *   4. Debounced flush: batch rapid WS bursts into one postMessage per 33ms
 *
 * Main thread receives pre-assembled plane objects — zero array destructuring,
 * zero property assignment loops. Only projection + trackStore + React setState remain.
 *
 * Message protocol (Worker → Main):
 *   PLANES_BATCH  { changed: {[icao24]: PlaneObj}, removed: string[], globalTime, totalCount }
 *   WS_CONNECTED  null
 *   WS_DISCONNECTED null
 *   WS_ERROR      string
 *   TELEMETRY_UPDATED { totalApiHits, nextFetchIn, accounts }
 *
 * Message protocol (Main → Worker):
 *   INIT          { baseUrl: string }
 *   SET_VIEWPORT  { lamin, lomin, lamax, lomax }
 *   DISCONNECT    null
 */

import * as msgpack from 'msgpack-lite';

// Buffer polyfill for workers (msgpack-lite dependency)
if (typeof self !== 'undefined' && typeof self.Buffer === 'undefined') {
    self.Buffer = {
        isBuffer: () => false,
        from: (data) => new Uint8Array(data)
    };
}

// ── WebSocket State ──────────────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_DELAY = 10000;

// ── Consolidated Plane State ─────────────────────────────────────────────────
// Full authoritative state of every aircraft — maintained entirely off-thread
const planesMap = new Map();     // icao24 → plane object
const dirtySet = new Set();      // icao24s changed since last flush
const removedList = [];          // icao24s removed since last flush
let latestGlobalTime = 0;

// ── Debounced Flush ──────────────────────────────────────────────────────────
// Batches rapid WS delta bursts into a single postMessage per frame (~33ms)
const FLUSH_INTERVAL = 33; // ms — ~30fps, well above Canvas render rate
let flushTimer = null;

function scheduleFlush() {
    if (flushTimer !== null) return; // already scheduled
    flushTimer = setTimeout(flush, FLUSH_INTERVAL);
}

function flush() {
    flushTimer = null;

    if (dirtySet.size === 0 && removedList.length === 0) return;

    // Build the changed planes dict — only planes that actually changed
    const changed = {};
    for (const id of dirtySet) {
        const p = planesMap.get(id);
        if (p) changed[id] = p;
    }

    // Post the batch to main thread
    postMessage({
        type: 'PLANES_BATCH',
        payload: {
            changed,
            removed: removedList.length > 0 ? removedList.slice() : [],
            globalTime: latestGlobalTime,
            totalCount: planesMap.size
        }
    });

    // Reset accumulators
    dirtySet.clear();
    removedList.length = 0;
}

// ── Delta Processing (the hot path — now entirely off main thread) ───────────
function processDelta(updates, removed, time) {
    latestGlobalTime = time;

    // 1. Apply removals
    for (let i = 0; i < removed.length; i++) {
        const id = removed[i];
        planesMap.delete(id);
        removedList.push(id);
    }

    // 2. Apply updates — array→object conversion
    // Format: [icao24, lat, lng, heading, altitude, velocity, onGround,
    //          category, isEmergency, callsign, vRate, squawk, lastContact, typecode]
    for (let i = 0; i < updates.length; i++) {
        const u = updates[i];
        const id = u[0];

        let p = planesMap.get(id);
        if (!p) {
            p = { icao24: id, _isNew: true };
            planesMap.set(id, p);
        } else {
            p._isNew = false;
        }

        p.lat = u[1];
        p.lng = u[2];
        p.heading = u[3];
        p.altitude = u[4];
        p.velocity = u[5];
        p.onGround = u[6];
        p.category = u[7];
        p.isEmergency = u[8];
        p.callsign = u[9];
        p.vRate = u[10];
        p.squawk = u[11];
        p.lastContact = u[12];
        if (u[13]) p.typecode = u[13];

        dirtySet.add(id);
    }

    // 3. Schedule a debounced flush
    scheduleFlush();
}

// ── Message Handlers ─────────────────────────────────────────────────────────
function handleDecodedMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'init') {
        return;
    }

    if (msg.type === 'delta') {
        const { time, updates = [], removed = [] } = msg;
        processDelta(updates, removed, time);
    }

    if (msg.type === 'telemetry') {
        postMessage({ type: 'TELEMETRY_UPDATED', payload: msg });
    }
}

// ── WebSocket Connection ─────────────────────────────────────────────────────
function connectWebSocket(baseUrl) {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
    console.log(`[FlightWorker] Connecting: ${wsUrl}`);

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        console.log('[FlightWorker] WebSocket connected.');
        reconnectDelay = 1000;
        postMessage({ type: 'WS_CONNECTED', payload: null });
    };

    ws.onmessage = (event) => {
        try {
            if (event.data instanceof ArrayBuffer) {
                const decoded = msgpack.decode(new Uint8Array(event.data));
                handleDecodedMessage(decoded);
            }
        } catch (err) {
            console.error('[FlightWorker] Decode error:', err);
            postMessage({ type: 'WS_ERROR', payload: 'Decode failed' });
        }
    };

    ws.onclose = () => {
        console.log(`[FlightWorker] Disconnected. Reconnect in ${reconnectDelay}ms`);
        postMessage({ type: 'WS_DISCONNECTED', payload: null });
        scheduleReconnect(baseUrl);
    };

    ws.onerror = () => {
        ws.close();
    };
}

function scheduleReconnect(baseUrl) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connectWebSocket(baseUrl), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
}

// ── Main Thread Interface ────────────────────────────────────────────────────
self.onmessage = (event) => {
    const { type, payload } = event.data;

    switch (type) {
        case 'INIT':
            connectWebSocket(payload.baseUrl);
            break;
        case 'SET_VIEWPORT':
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(msgpack.encode({ type: 'SET_VIEWPORT', payload }));
            }
            break;
        case 'DISCONNECT':
            if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
            flush(); // send any pending changes
            if (ws) { ws.onclose = null; ws.close(); ws = null; }
            if (reconnectTimer) clearTimeout(reconnectTimer);
            break;
    }
};
