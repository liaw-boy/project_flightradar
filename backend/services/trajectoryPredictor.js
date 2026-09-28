'use strict';
// Client for the ml_trajectory/infer_server.py FastAPI service. Used by
// broadcastEngine.js to extrapolate a plane's position during a short
// signal-loss window instead of freezing it at its last known point.
// Fails soft: any error/timeout/unreachable service just yields no
// predictions, and callers fall back to their existing behavior.

const PREDICTOR_URL = process.env.TRAJECTORY_PREDICTOR_URL || 'http://127.0.0.1:8801';
// [2026-09-28] Re-measured against the current sampled batch size (~1/5 of
// fleet, typically ~1900-2200 items — see broadcastEngine.js's
// PREDICTION_SAMPLE_SLICES): a solo call takes ~150-220ms; three overlapping
// calls (this shared, multi-tenant host's other load, or a slow GPU moment)
// serialize to ~550-650ms each. The 2s timeout this replaces was tripping
// every ~15-25 min on nothing worse than that — real stalls, not a batch-size
// problem, but nowhere near 2s of genuine compute. Generous on purpose:
// predictions are background-only right now (prediction_log accuracy
// tracking; MapView's Phase 2 display blend is disabled), so a slower
// response has no user-facing cost, while a spurious timeout still trips the
// circuit breaker below for a full UNAVAILABLE_BACKOFF_MS.
const REQUEST_TIMEOUT_MS = 5000;

let _unavailableUntil = 0; // brief circuit breaker so a dead service doesn't add latency every cycle
const UNAVAILABLE_BACKOFF_MS = 15_000;

// [2026-09-28] Nothing previously stopped broadcastEngine's ~2s cycle from
// firing a new call while the last one was still in flight — measured 3x
// overlap alone triples per-call latency (serialized on the predictor's
// single worker), which is exactly the kind of self-inflicted pile-up that
// pushes an otherwise-fine call over the timeout. Skip a cycle instead of
// stacking another concurrent request on top.
let _inFlight = false;

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
    if (_inFlight) return results; // a previous call hasn't returned yet — don't stack another on top

    _inFlight = true;
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
    } finally {
        _inFlight = false;
    }
    stats.lastLatencyMs = Date.now() - startMs;
    stats.lastAt = Date.now();
    return results;
}

function getStats() {
    return { ...stats, circuitOpenUntil: _unavailableUntil, inFlight: _inFlight };
}

module.exports = { predictBatch, getStats };
