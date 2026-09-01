'use strict';
// Client for the ml_trajectory/infer_server.py FastAPI service. Used by
// broadcastEngine.js to extrapolate a plane's position during a short
// signal-loss window instead of freezing it at its last known point.
// Fails soft: any error/timeout/unreachable service just yields no
// predictions, and callers fall back to their existing behavior.

const PREDICTOR_URL = process.env.TRAJECTORY_PREDICTOR_URL || 'http://127.0.0.1:8801';
// Measured: a 5000-item batch (realistic full-fleet size) takes ~290ms of pure
// inference time alone; Node-side JSON (de)serialization adds more on top.
// This must scale with fleet size, not stay fixed at the old "handful of
// stale planes" figure — a too-tight timeout here reads as "service is down"
// and trips the circuit breaker below on every single cycle.
const REQUEST_TIMEOUT_MS = 2000;

let _unavailableUntil = 0; // brief circuit breaker so a dead service doesn't add latency every cycle
const UNAVAILABLE_BACKOFF_MS = 15_000;

// Rolling call-outcome stats — the only visibility into predictBatch's health
// without tailing logs; exposed via getStats() for a future /api/debug route.
const stats = { calls: 0, successes: 0, failures: 0, lastError: null, lastLatencyMs: null, lastAt: null };

/**
 * predictBatch(items) -> Map<icao24, {lat, lng, altitude}>
 * items: [{ icao24, sequence: [{lat,lng,altitude,velocity,heading}, ... 10 points], stepsAhead }]
 * stepsAhead: how many RESAMPLE_DT_S-sized steps to roll the model forward
 * (see ml_trajectory/dataset.py) — defaults to 1 on the server if omitted.
 */
async function predictBatch(items) {
    const results = new Map();
    if (!items || items.length === 0) return results;
    if (Date.now() < _unavailableUntil) return results;

    stats.calls++;
    const startMs = Date.now();
    try {
        const res = await fetch(`${PREDICTOR_URL}/predict_batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`predictor HTTP ${res.status}`);
        const data = await res.json();
        for (const [icao24, pred] of Object.entries(data.predictions || {})) {
            results.set(icao24, pred);
        }
        stats.successes++;
        stats.lastError = null;
    } catch (err) {
        stats.failures++;
        stats.lastError = err.message;
        console.error(`[trajectoryPredictor] predict_batch failed (${items.length} items): ${err.message} — backing off ${UNAVAILABLE_BACKOFF_MS}ms`);
        _unavailableUntil = Date.now() + UNAVAILABLE_BACKOFF_MS;
    }
    stats.lastLatencyMs = Date.now() - startMs;
    stats.lastAt = Date.now();
    return results;
}

function getStats() {
    return { ...stats, circuitOpenUntil: _unavailableUntil };
}

module.exports = { predictBatch, getStats };
