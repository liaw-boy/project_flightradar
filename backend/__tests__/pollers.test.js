'use strict';
/**
 * Unit test for the total-outage alert in services/pollers.js
 * fetchGlobalBaseline — escalates to an ERROR-level log only after
 * adsb.lol + adsb.fi-snap have BOTH failed for several consecutive
 * cycles (not on a single transient miss), and is throttled so a
 * sustained outage doesn't spam the log every 5s.
 *
 * Mocks global.fetch so every upstream call fails.
 *
 * [2026-09] A third fallback tier (OpenSky) used to sit behind adsb.lol/
 * adsb.fi-snap and was injected here as a mocked fetchOpenSkyBaselineFallback
 * — removed along with the rest of the OpenSky integration (its API is
 * dead). "Total outage" is now strictly a two-source check.
 */
const logger = require('../logger');
const { getGlobalPlanesCache, sourceHealth } = require('../state/appState');
const { createPollers } = require('../services/pollers');
const { cbReset } = require('../services/circuitBreaker');

describe('fetchGlobalBaseline total-outage alert', () => {
    let errorSpy;
    let originalFetch;

    beforeEach(() => {
        for (const k of Object.keys(sourceHealth)) delete sourceHealth[k];
        errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
        jest.spyOn(logger, 'warn').mockImplementation(() => {});
        jest.spyOn(logger, 'info').mockImplementation(() => {});
        jest.spyOn(logger, 'debug').mockImplementation(() => {});
        originalFetch = global.fetch;
        global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed'));
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    function makePollers() {
        return createPollers({
            normalizeAcRecord: p => p,
            ingestTrackPoints: jest.fn().mockResolvedValue(undefined),
            triggerBackgroundResolution: () => {},
        });
    }

    test('does not alert on a single failed cycle', async () => {
        const { fetchGlobalBaseline } = makePollers();
        await fetchGlobalBaseline();

        const alerts = errorSpy.mock.calls.filter(c => c[0] === 'ALERT');
        expect(alerts).toHaveLength(0);
        expect(getGlobalPlanesCache().stale).toBe(true);
    });

    test('alerts once total outage reaches the consecutive-cycle threshold', async () => {
        const { fetchGlobalBaseline } = makePollers();

        // Threshold is 8 cycles (~120s at the current 15s poll interval) —
        // see the rationale comment in pollers.js next to
        // TOTAL_OUTAGE_ALERT_THRESHOLD / GLOBAL_BASELINE_INTERVAL_SEC.
        for (let i = 0; i < 7; i++) await fetchGlobalBaseline();
        expect(errorSpy.mock.calls.filter(c => c[0] === 'ALERT')).toHaveLength(0);

        await fetchGlobalBaseline(); // 8th consecutive total-outage cycle — threshold
        const alerts = errorSpy.mock.calls.filter(c => c[0] === 'ALERT');
        expect(alerts).toHaveLength(1);
        expect(alerts[0][1]).toMatch(/dark for 120s\+/);
    });

    test('does not re-alert every cycle while the outage persists (throttled)', async () => {
        const { fetchGlobalBaseline } = makePollers();
        for (let i = 0; i < 12; i++) await fetchGlobalBaseline(); // past the 8-cycle threshold, then some more

        const alerts = errorSpy.mock.calls.filter(c => c[0] === 'ALERT');
        expect(alerts).toHaveLength(1); // throttle window (5 min) hasn't elapsed
    });

    test('outage counter resets once a source recovers — no alert on the next isolated blip', async () => {
        // Cycle 1: both adsb.lol and adsb.fi-snap fetch calls reject, tripping
        // both circuit breakers (short "transient" cooldown). Cycle 2: both
        // breakers are still open, so fetchGlobalBaseline never calls
        // global.fetch at all that cycle (suppressed at the cbOpen check).
        // Before cycle 3, adsb.lol's breaker is reset directly (simulating its
        // cooldown having elapsed) so its single fetch call actually happens
        // and is mocked to succeed — a "recovery". adsb.fi-snap's breaker is
        // still open on cycles 3-4, so only adsb.lol's calls reach the mock.
        global.fetch = jest.fn()
            .mockRejectedValueOnce(new Error('fetch failed'))   // cycle 1: adsb.lol
            .mockRejectedValueOnce(new Error('fetch failed'))   // cycle 1: adsb.fi-snap
            .mockResolvedValueOnce({                            // cycle 3: adsb.lol recovers
                ok: true,
                json: async () => ({ ac: [{ hex: 'abc123', lat: 25, lng: 121, seen_pos: 0 }], now: Date.now() }),
            })
            .mockRejectedValueOnce(new Error('fetch failed'));  // cycle 4: adsb.lol fails again
        const { fetchGlobalBaseline } = makePollers();

        await fetchGlobalBaseline(); // outage cycle 1
        await fetchGlobalBaseline(); // outage cycle 2 — both breakers still open, no new fetch attempts
        cbReset('adsb.lol', 0, 0);   // simulate adsb.lol's cooldown having elapsed naturally
        await fetchGlobalBaseline(); // recovers — adsb.lol succeeds, counter resets
        await fetchGlobalBaseline(); // adsb.lol fails again — outage cycle 1, not 4th consecutive

        const alerts = errorSpy.mock.calls.filter(c => c[0] === 'ALERT');
        expect(alerts).toHaveLength(0);
    });
});
