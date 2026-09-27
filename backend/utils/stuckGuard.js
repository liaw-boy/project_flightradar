'use strict';
// Wraps the "skip if already running" reentrancy guard used throughout
// pollers.js/broadcastEngine.js (if (running) return; running = true; ...
// finally { running = false }) with a watchdog.
//
// [2026-09-27 incident] That plain-boolean shape has no recovery path: if the
// awaited work inside truly hangs (never reaches its own finally — not just
// runs slow), the flag stays true forever and every later tick is silently
// skipped, forever, with zero log trace. fetchGlobalBaseline got stuck this
// way for 45 minutes after a database stall during a DB rebuild — the map
// served position data 45 minutes stale, and the `stale` flag was never set
// because no cycle ever ran to notice the failure. Discovered by chance, not
// by any alert.
//
// This makes a stuck guard loud quickly and self-heals eventually, rather
// than staying stuck until a human happens to notice and restarts the
// service by hand.
const logger = require('../logger');

const ALERT_AFTER_MS = 3 * 60_000;        // generous vs. any real cycle (worst observed: ~8s)
const FORCE_CLEAR_AFTER_MS = 10 * 60_000; // last-resort self-heal

function createStuckGuard(name, notifyDiscord) {
    const state = { running: false, since: 0, alerted: false };

    return {
        // Call at the very top, in place of `if (running) return;`. Returns
        // true if this tick should be skipped.
        shouldSkip() {
            if (!state.running) return false;
            const stuckMs = Date.now() - state.since;
            // Alert is checked (and can fire) before the force-clear check below,
            // not after — a caller that polls infrequently enough to leap past
            // both thresholds in one check must still get notified, not just
            // silently self-heal with no one told a lock ever had to be broken.
            if (stuckMs > ALERT_AFTER_MS && !state.alerted) {
                state.alerted = true;
                logger.error('WATCHDOG', `${name} has been running for ${Math.round(stuckMs / 1000)}s with no completion — likely stuck`);
                if (notifyDiscord) {
                    notifyDiscord({
                        icon: 'failed', color: 'red',
                        title: `AEROSTRAT ${name} 卡住超過 ${ALERT_AFTER_MS / 60_000} 分鐘`,
                        description: `上一輪從未執行到結束，${FORCE_CLEAR_AFTER_MS / 60_000} 分鐘後會自動強制解鎖重試。`,
                    }, 'DISCORD_OUTAGE_WEBHOOK_URL');
                }
            }
            if (stuckMs > FORCE_CLEAR_AFTER_MS) {
                // The stuck call may still be out there and could still finish
                // later — a rare double-run is possible, but strictly better
                // than staying dark indefinitely.
                logger.error('WATCHDOG', `${name} force-cleared after being stuck ${Math.round(stuckMs / 1000)}s ` +
                    '— the previous run never reached its own finally block');
                state.running = false;
                state.alerted = false;
                return false;
            }
            return true;
        },
        enter() {
            state.running = true;
            state.since = Date.now();
            state.alerted = false;
        },
        exit() {
            state.running = false;
        },
    };
}

module.exports = { createStuckGuard };
