'use strict';
// Per-source circuit breaker for the flight data fusion engine. Backed by
// state/appState's sourceHealth object, so the module-level circuit state
// (open/tripped/reset) is visible to every consumer that imports it.
const logger = require('../logger');
const { sourceHealth } = require('../state/appState');

const SOURCE_CB_MS = 5 * 60_000;      // base backoff (also the explicit-ms default)
const SOURCE_CB_MAX_MS = 30 * 60_000; // cap so a chronic outage doesn't lock a source out for hours

const cbOpen  = k => (sourceHealth[k]?.cbUntil || 0) > Date.now();

// ms: explicit override (e.g. a known long-lived block like a 403 ban).
// Omitted -> exponential backoff from consecutiveFails (5m, 10m, 20m, capped
// at 30m), so a source that keeps failing every single cycle gets backed off
// progressively instead of being retried at the same fixed cadence forever —
// hammering a host that's already timing out on every request risks making
// an upstream anti-abuse block worse, not better.
const cbTrip  = (k, ms) => {
    const consecutiveFails = (sourceHealth[k]?.consecutiveFails || 0) + 1;
    const backoffMs = ms ?? Math.min(SOURCE_CB_MS * (2 ** (consecutiveFails - 1)), SOURCE_CB_MAX_MS);
    sourceHealth[k] = {
        ...sourceHealth[k],
        cbUntil: Date.now() + backoffMs,
        consecutiveFails,
    };
};

const cbReset = (k, count, latency) => {
    sourceHealth[k] = { cbUntil: 0, consecutiveFails: 0, lastOk: Date.now(), lastCount: count, lastLatency: latency };
};

// A source held open by its circuit breaker used to fail silently — the skip
// path logged nothing, so a permanently dead upstream (adsb.fi's /snapshot
// started returning 403) looked identical to a healthy one in the logs.
// Report it, throttled per source so a long outage doesn't flood the log.
const CB_LOG_THROTTLE_MS = 10 * 60_000;
const _cbLoggedAt = {};
function logSuppressedSource(key) {
    const now = Date.now();
    if (now - (_cbLoggedAt[key] || 0) < CB_LOG_THROTTLE_MS) return;
    _cbLoggedAt[key] = now;
    const until = sourceHealth[key]?.cbUntil || now;
    const fails = sourceHealth[key]?.consecutiveFails || 0;
    logger.warn('SYNC', `${key} suppressed by circuit breaker — ${Math.ceil((until - now) / 60_000)} min left, ${fails} consecutive failures`);
}

module.exports = { SOURCE_CB_MS, cbOpen, cbTrip, cbReset, logSuppressedSource };
