'use strict';
// Per-source circuit breaker for the flight data fusion engine. Backed by
// state/appState's sourceHealth object, so the module-level circuit state
// (open/tripped/reset) is visible to every consumer that imports it.
const logger = require('../logger');
const { sourceHealth } = require('../state/appState');

const SOURCE_CB_MS = 5 * 60_000;      // legacy fixed-ms default, kept for explicit-ms callers
const SOURCE_CB_MAX_MS = 30 * 60_000; // legacy cap

// [2026-09-06] adsb.lol/adsb.fi went "both failed" 58k times in 7 days
// despite adsb.lol's own public status page showing 100% uptime that same
// week (github.com/adsblol/status) — the upstream was fine; a single 5s
// network blip was getting trip'd at a flat 5-minute cooldown (doubling to
// 30m on the next unlucky cycle) regardless of what actually failed. Real
// abuse blocks (403) and real quota signals (429) warrant a long cooldown;
// a timeout or a 5xx from an otherwise-healthy host doesn't. Classifying the
// failure lets each kind back off on its own, appropriately-sized curve
// instead of one flat curve for everything — see cockatiel/opossum (Node's
// two most common circuit-breaker libs), whose default reset timeouts sit
// in the 10-30s range specifically for this reason.
const FAILURE_TIERS = {
    // Confirmed access block — retrying soon just extends the ban. adsb.fi's
    // own published policy: "Requests returning a 400, 401, 403, 404, or 429
    // status code count toward the [restriction] limit" — a fixed 1h cooldown
    // that never escalated meant every hourly retry landed another 403,
    // which by that policy re-armed the restriction forever. Observed: 70
    // consecutive hourly 403s (2.9 days straight) on adsb.fi-snap, since the
    // very first request this service instance made — never once recovered
    // because we kept refreshing our own block. Escalate like rateLimited so
    // a real temporary IP restriction gets long enough gaps to actually
    // expire, instead of us re-triggering it every single hour indefinitely.
    blocked:     { baseMs: 60 * 60_000, maxMs: 24 * 60 * 60_000 },
    // A real quota/abuse signal from the host — back off meaningfully, but
    // don't lock it out for as long as a confirmed block.
    rateLimited: { baseMs: 5 * 60_000, maxMs: 30 * 60_000 },
    // Timeout, connection reset, 5xx, or anything else with no explicit
    // status — most likely a momentary blip on an otherwise-healthy host.
    // Short base so the very next poll cycle (5s later) is already past a
    // first-offense cooldown, escalating only if it keeps happening.
    transient:   { baseMs: 10_000, maxMs: 5 * 60_000 },
};

const cbOpen = k => (sourceHealth[k]?.cbUntil || 0) > Date.now();

function classifyFailure(reason = '') {
    if (/\b403\b/.test(reason)) return 'blocked';
    if (/\b429\b/.test(reason)) return 'rateLimited';
    return 'transient';
}

// reasonOrMs: a caught error's message string (preferred — gets classified
// into a tier above) or, for backward compatibility, an explicit ms number.
// Escalation (2x per consecutive fail, capped per-tier) only compounds
// within the SAME tier — a source flapping between transient blips and a
// real 429 shouldn't inherit backoff built up under the other failure kind.
const cbTrip = (k, reasonOrMs) => {
    const prev = sourceHealth[k];
    const explicitMs = typeof reasonOrMs === 'number';
    const tierKey = explicitMs ? null : classifyFailure(reasonOrMs);
    const tier = tierKey ? FAILURE_TIERS[tierKey] : null;
    const consecutiveFails = (!explicitMs && prev?.tier === tierKey) ? (prev.consecutiveFails || 0) + 1 : 1;
    const backoffMs = explicitMs
        ? reasonOrMs
        : Math.min(tier.baseMs * (2 ** (consecutiveFails - 1)), tier.maxMs);
    sourceHealth[k] = {
        ...prev,
        cbUntil: Date.now() + backoffMs,
        consecutiveFails,
        tier: tierKey,
        lastFailReason: typeof reasonOrMs === 'string' ? reasonOrMs : (prev?.lastFailReason ?? null),
    };
    logger.warn('CB', `${k} tripped — ${tierKey ? `tier=${tierKey} (${reasonOrMs})` : 'explicit-ms'}, cooldown=${Math.round(backoffMs / 1000)}s, fail #${consecutiveFails}`);
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

module.exports = { SOURCE_CB_MS, FAILURE_TIERS, classifyFailure, cbOpen, cbTrip, cbReset, logSuppressedSource };
