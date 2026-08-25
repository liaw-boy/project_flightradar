'use strict';
// Per-source circuit breaker for the flight data fusion engine. Backed by
// state/appState's sourceHealth object, so the module-level circuit state
// (open/tripped/reset) is visible to every consumer that imports it.
const logger = require('../logger');
const { sourceHealth } = require('../state/appState');

const SOURCE_CB_MS = 5 * 60_000;  // 5 min backoff on 429/503

const cbOpen  = k => (sourceHealth[k]?.cbUntil || 0) > Date.now();

const cbTrip  = (k, ms = SOURCE_CB_MS) => {
    sourceHealth[k] = {
        ...sourceHealth[k],
        cbUntil: Date.now() + ms,
        consecutiveFails: (sourceHealth[k]?.consecutiveFails || 0) + 1,
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
