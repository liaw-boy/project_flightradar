'use strict';
/**
 * Unit test for the total-outage alert in services/pollers.js
 * fetchGlobalBaseline — escalates to an ERROR-level log only after
 * adsb.lol + adsb.fi-snap + the OpenSky fallback have ALL failed for
 * several consecutive cycles (not on a single transient miss), and is
 * throttled so a sustained outage doesn't spam the log every 5s.
 *
 * Mocks global.fetch so every upstream call fails, and injects a
 * fetchOpenSkyBaselineFallback that always returns [] (fallback also dark).
 */
const logger = require('../logger');
const { getGlobalPlanesCache, sourceHealth } = require('../state/appState');
const { createPollers } = require('../services/pollers');

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
            fetchOpenSkyBaselineFallback: jest.fn().mockResolvedValue([]), // fallback also dark
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

        await fetchGlobalBaseline();
        await fetchGlobalBaseline();
        expect(errorSpy.mock.calls.filter(c => c[0] === 'ALERT')).toHaveLength(0);

        await fetchGlobalBaseline(); // 3rd consecutive total-outage cycle — threshold
        const alerts = errorSpy.mock.calls.filter(c => c[0] === 'ALERT');
        expect(alerts).toHaveLength(1);
        expect(alerts[0][1]).toMatch(/dark for 15s\+/);
    });

    test('does not re-alert every cycle while the outage persists (throttled)', async () => {
        const { fetchGlobalBaseline } = makePollers();
        for (let i = 0; i < 6; i++) await fetchGlobalBaseline();

        const alerts = errorSpy.mock.calls.filter(c => c[0] === 'ALERT');
        expect(alerts).toHaveLength(1); // throttle window (5 min) hasn't elapsed
    });

    test('outage counter resets once a source recovers — no alert on the next isolated blip', async () => {
        const fallback = jest.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ icao24: 'abc123', lat: 25, lng: 121, posTime: Date.now() / 1000 }]) // recovers
            .mockResolvedValueOnce([]);
        const { fetchGlobalBaseline } = createPollers({
            normalizeAcRecord: p => p,
            fetchOpenSkyBaselineFallback: fallback,
            ingestTrackPoints: jest.fn().mockResolvedValue(undefined),
            triggerBackgroundResolution: () => {},
        });

        await fetchGlobalBaseline(); // outage cycle 1
        await fetchGlobalBaseline(); // outage cycle 2
        await fetchGlobalBaseline(); // recovers — counter resets
        await fetchGlobalBaseline(); // outage cycle 1 again, not 4th consecutive

        const alerts = errorSpy.mock.calls.filter(c => c[0] === 'ALERT');
        expect(alerts).toHaveLength(0);
    });
});
