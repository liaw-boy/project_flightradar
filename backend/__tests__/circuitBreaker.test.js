'use strict';
/**
 * Unit tests for services/circuitBreaker.js — per-source backoff used by
 * all three polling tiers to stop hammering a failing upstream (429/503/403).
 */
const { sourceHealth } = require('../state/appState');
const { cbOpen, cbTrip, cbReset, classifyFailure, FAILURE_TIERS } = require('../services/circuitBreaker');

beforeEach(() => {
    for (const k of Object.keys(sourceHealth)) delete sourceHealth[k];
});

describe('cbOpen / cbTrip / cbReset', () => {
    test('a source with no recorded health is not open', () => {
        expect(cbOpen('never-seen')).toBe(false);
    });

    test('cbTrip opens the breaker for the given source only', () => {
        cbTrip('adsb.lol');
        expect(cbOpen('adsb.lol')).toBe(true);
        expect(cbOpen('adsb.fi-snap')).toBe(false);
    });

    test('cbTrip respects a custom backoff duration', () => {
        cbTrip('adsb.fi-snap', 100); // 100ms — short enough to observe expiry
        expect(cbOpen('adsb.fi-snap')).toBe(true);
        expect(sourceHealth['adsb.fi-snap'].cbUntil).toBeLessThanOrEqual(Date.now() + 100);
    });

    test('cbTrip with no reason classifies as transient and increments consecutiveFails on repeat trips', () => {
        cbTrip('adsb.lol');
        expect(sourceHealth['adsb.lol'].consecutiveFails).toBe(1);
        expect(sourceHealth['adsb.lol'].tier).toBe('transient');
        const firstCbUntil = sourceHealth['adsb.lol'].cbUntil;
        expect(firstCbUntil).toBeGreaterThanOrEqual(Date.now() + FAILURE_TIERS.transient.baseMs - 1000);

        cbTrip('adsb.lol');
        expect(sourceHealth['adsb.lol'].consecutiveFails).toBe(2);
    });

    test('classifyFailure sorts reasons into blocked/rateLimited/transient tiers', () => {
        expect(classifyFailure('HTTP 403')).toBe('blocked');
        expect(classifyFailure('HTTP 429')).toBe('rateLimited');
        expect(classifyFailure('fetch failed')).toBe('transient');
        expect(classifyFailure('The operation was aborted')).toBe('transient');
    });

    test('a 403 reason trips a long, capped cooldown regardless of consecutive fails', () => {
        cbTrip('adsb.fi-snap', 'HTTP 403');
        expect(sourceHealth['adsb.fi-snap'].tier).toBe('blocked');
        expect(sourceHealth['adsb.fi-snap'].cbUntil).toBeGreaterThanOrEqual(Date.now() + FAILURE_TIERS.blocked.baseMs - 1000);
    });

    test('switching failure tier resets escalation instead of compounding across tiers', () => {
        cbTrip('adsb.lol', 'fetch failed');    // transient, fail #1
        cbTrip('adsb.lol', 'fetch failed');    // transient, fail #2 — escalates
        expect(sourceHealth['adsb.lol'].consecutiveFails).toBe(2);

        cbTrip('adsb.lol', 'HTTP 429');        // different tier — starts over at #1
        expect(sourceHealth['adsb.lol'].tier).toBe('rateLimited');
        expect(sourceHealth['adsb.lol'].consecutiveFails).toBe(1);
    });

    test('cbReset clears the breaker and consecutiveFails, records lastOk/lastCount/lastLatency', () => {
        cbTrip('adsb.lol');
        cbTrip('adsb.lol');
        expect(cbOpen('adsb.lol')).toBe(true);

        cbReset('adsb.lol', 6981, 542);
        expect(cbOpen('adsb.lol')).toBe(false);
        expect(sourceHealth['adsb.lol']).toMatchObject({
            cbUntil: 0,
            consecutiveFails: 0,
            lastCount: 6981,
            lastLatency: 542,
        });
        expect(sourceHealth['adsb.lol'].lastOk).toBeLessThanOrEqual(Date.now());
    });

    test('an expired trip (cbUntil in the past) reports as not open', () => {
        cbTrip('adsb.fi-snap', -1); // already-expired window
        expect(cbOpen('adsb.fi-snap')).toBe(false);
    });

    test('sources are tracked independently — tripping one never affects another', () => {
        cbTrip('adsb.lol');
        cbTrip('al-point');
        cbReset('adsb.lol', 100, 50);
        expect(cbOpen('adsb.lol')).toBe(false);
        expect(cbOpen('al-point')).toBe(true);
    });
});
