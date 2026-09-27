/**
 * Regression test for the 2026-09-27 incident: fetchGlobalBaseline's
 * boolean reentrancy guard got stuck (the awaited work never reached its
 * own finally) and silently skipped every later tick for 45 minutes with
 * zero log trace. createStuckGuard must (a) let a normal, quick in-flight
 * run skip silently, (b) alert loudly once a run has been "in progress" far
 * longer than any real cycle takes, and (c) eventually force-clear so
 * polling resumes on its own instead of staying dark until someone notices
 * and restarts the service by hand.
 */
const { createStuckGuard } = require('../utils/stuckGuard');

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.setSystemTime(0);
});

afterEach(() => {
    jest.useRealTimers();
});

test('a quick, still-in-flight run is skipped silently — no alert', () => {
    const notify = jest.fn();
    const guard = createStuckGuard('quickJob', notify);

    guard.enter();
    jest.advanceTimersByTime(2_000); // 2s later, still running — normal overlap
    expect(guard.shouldSkip()).toBe(true);
    expect(notify).not.toHaveBeenCalled();

    guard.exit();
    expect(guard.shouldSkip()).toBe(false); // free to run again once exited
});

test('a run stuck past the alert threshold fires exactly one Discord alert', () => {
    const notify = jest.fn();
    const guard = createStuckGuard('stuckJob', notify);

    guard.enter();
    jest.advanceTimersByTime(3 * 60_000 + 1);
    expect(guard.shouldSkip()).toBe(true); // still skipped — not yet force-clear time
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].title).toContain('stuckJob');
    expect(notify.mock.calls[0][1]).toBe('DISCORD_OUTAGE_WEBHOOK_URL');

    // Repeated checks while still stuck must not spam a second alert.
    jest.advanceTimersByTime(60_000);
    expect(guard.shouldSkip()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
});

test('a run stuck past the force-clear threshold is unlocked automatically', () => {
    const notify = jest.fn();
    const guard = createStuckGuard('deadlockedJob', notify);

    guard.enter();
    jest.advanceTimersByTime(10 * 60_000 + 1);
    // The caller's next tick is now let through instead of skipped forever.
    expect(guard.shouldSkip()).toBe(false);
});

test('re-entering after a force-clear resets the alert state for the new run', () => {
    const notify = jest.fn();
    const guard = createStuckGuard('recoveredJob', notify);

    guard.enter();
    jest.advanceTimersByTime(10 * 60_000 + 1);
    expect(guard.shouldSkip()).toBe(false); // force-cleared
    expect(notify).toHaveBeenCalledTimes(1); // the earlier alert, from being stuck

    guard.enter(); // caller starts its (hopefully un-stuck) retry
    jest.advanceTimersByTime(1_000);
    expect(guard.shouldSkip()).toBe(true); // just a normal quick overlap now
    expect(notify).toHaveBeenCalledTimes(1); // no new alert for a fresh, non-stuck run
});
