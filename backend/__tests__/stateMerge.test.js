'use strict';
/**
 * Unit tests for services/stateMerge.js — the position-arbitration logic
 * that fixed the "moves forward then snaps back" production bug (dual
 * Tier 1/Tier 2 pollers racing to write the same icao24 with no
 * coordination). Pure logic, no live server required — seeds
 * state/appState's masterStateMap directly.
 */
const { masterStateMap } = require('../state/appState');
const { isPositionUpdateTrustworthy, mergeStates } = require('../services/stateMerge');
const { getDistance } = require('../utils/planeGuards');

function plane(overrides = {}) {
    return {
        icao24: 'abc123',
        lat: 25.0, lng: 121.0,
        heading: 90, velocity: 200, altitude: 10000, onGround: false,
        posTime: 1000,
        ...overrides,
    };
}

beforeEach(() => {
    masterStateMap.clear();
});

describe('isPositionUpdateTrustworthy', () => {
    test('first sighting (no existing record) is always trustworthy', () => {
        expect(isPositionUpdateTrustworthy(null, plane())).toBe(true);
    });

    test('missing posTime on either side cannot be arbitrated — trustworthy', () => {
        const existing = plane({ posTime: undefined });
        const incoming = plane({ posTime: 1000 });
        expect(isPositionUpdateTrustworthy(existing, incoming)).toBe(true);
        expect(isPositionUpdateTrustworthy(plane({ posTime: 1000 }), plane({ posTime: undefined }))).toBe(true);
    });

    test('older posTime than existing is rejected outright (guard 1)', () => {
        const existing = plane({ posTime: 1000 });
        const incoming = plane({ posTime: 990 });
        expect(isPositionUpdateTrustworthy(existing, incoming)).toBe(false);
    });

    test('same-instant update (dtSec <= 0) is trustworthy — nothing to sanity-check', () => {
        const existing = plane({ posTime: 1000 });
        const incoming = plane({ posTime: 1000, lat: 30, lng: 130 });
        expect(isPositionUpdateTrustworthy(existing, incoming)).toBe(true);
    });

    test('guard 2: displacement bearing disagreeing >120° from reported heading is rejected', () => {
        // Existing at (25.0, 121.0); incoming moved ~111m due north (bearing ~0°)
        // but reports heading 180° (south) — an aircraft can't reverse course
        // that fast, so this should be flagged as an implausible update.
        const existing = plane({ lat: 25.0, lng: 121.0, posTime: 1000 });
        const incoming = plane({ lat: 25.001, lng: 121.0, heading: 180, posTime: 1005 });
        const distM = getDistance(existing.lat, existing.lng, incoming.lat, incoming.lng) * 1000;
        expect(distM).toBeGreaterThan(60); // sanity: over the noise-floor threshold
        expect(isPositionUpdateTrustworthy(existing, incoming)).toBe(false);
    });

    test('guard 2: displacement bearing matching reported heading is trustworthy', () => {
        const existing = plane({ lat: 25.0, lng: 121.0, posTime: 1000 });
        const incoming = plane({ lat: 25.001, lng: 121.0, heading: 0, posTime: 1005 });
        expect(isPositionUpdateTrustworthy(existing, incoming)).toBe(true);
    });

    test('guard 2 is skipped for onGround aircraft (taxiing tracks are noisy)', () => {
        // Same displacement/heading-disagreement as the rejected airborne case
        // above, but slower over a longer window so guard 3 (implied speed)
        // doesn't independently reject it — isolates guard 2's onGround bypass.
        const existing = plane({ lat: 25.0, lng: 121.0, posTime: 1000, onGround: true });
        const incoming = plane({ lat: 25.001, lng: 121.0, heading: 180, posTime: 1020, onGround: true, velocity: 5 });
        expect(isPositionUpdateTrustworthy(existing, incoming)).toBe(true);
    });

    test('guard 3: implied speed far exceeding reported velocity is rejected', () => {
        // ~11.1km in 1 second implies ~11,119 m/s — no aircraft reports that.
        // onGround:true on both sides sidesteps guard 2 so this isolates guard 3.
        const existing = plane({ lat: 25.0, lng: 121.0, posTime: 1000, onGround: true, velocity: 5 });
        const incoming = plane({ lat: 25.1, lng: 121.0, posTime: 1001, onGround: true, velocity: 5 });
        expect(isPositionUpdateTrustworthy(existing, incoming)).toBe(false);
    });

    test('guard 3 does not flag small jitter below the speed floor', () => {
        // ADS-B parked-aircraft jitter: a few meters over a few seconds.
        const existing = plane({ lat: 25.0, lng: 121.0, posTime: 1000, onGround: true, velocity: 0 });
        const incoming = plane({ lat: 25.00002, lng: 121.0, posTime: 1003, onGround: true, velocity: 0 });
        expect(isPositionUpdateTrustworthy(existing, incoming)).toBe(true);
    });
});

describe('mergeStates', () => {
    test('drops sentinel/reserved ICAO24 addresses (not real aircraft)', () => {
        mergeStates([plane({ icao24: '000000' }), plane({ icao24: 'ffffff' })], 'upsert');
        expect(masterStateMap.size).toBe(0);
    });

    test('keeps non-ICAO TIS-B/ADS-R targets (~-prefixed)', () => {
        mergeStates([plane({ icao24: '~abc123' })], 'upsert');
        expect(masterStateMap.has('~abc123')).toBe(true);
    });

    test("upsert strategy: enrichment fields (operator/model/typecode) carry forward from existing when the new record lacks them", () => {
        masterStateMap.set('abc123', plane({
            operator: 'EVA AIR', model: 'A321neo', typecode: 'A21N', posTime: 1000,
        }));
        // Fresh ADS-B poll — raw feed has no operator/model/typecode.
        mergeStates([plane({ posTime: 1005, operator: null, model: null, typecode: null })], 'upsert');
        const merged = masterStateMap.get('abc123');
        expect(merged.operator).toBe('EVA AIR');
        expect(merged.model).toBe('A321neo');
        expect(merged.typecode).toBe('A21N');
    });

    test('upsert strategy: position/telemetry always come from the new record, not preserved', () => {
        masterStateMap.set('abc123', plane({ altitude: 10000, posTime: 1000 }));
        mergeStates([plane({ altitude: 35000, posTime: 1005 })], 'upsert');
        expect(masterStateMap.get('abc123').altitude).toBe(35000);
    });

    test('upsert strategy: a signal-source label (e.g. "adsb_icao") never overwrites a valid existing typecode', () => {
        masterStateMap.set('abc123', plane({ typecode: 'B738', posTime: 1000 }));
        mergeStates([plane({ typecode: 'adsb_icao', posTime: 1005 })], 'upsert');
        expect(masterStateMap.get('abc123').typecode).toBe('B738');
    });

    test('merge strategy: preserves description/year in addition to operator/model/typecode', () => {
        masterStateMap.set('abc123', plane({
            description: 'AIRBUS A321NEO', year: 2021, posTime: 1000,
        }));
        mergeStates([plane({ posTime: 1005, description: null, year: null })], 'merge');
        const merged = masterStateMap.get('abc123');
        expect(merged.description).toBe('AIRBUS A321NEO');
        expect(merged.year).toBe(2021);
    });

    test('an untrustworthy position update still lets non-positional fields (squawk/callsign) through', () => {
        masterStateMap.set('abc123', plane({
            lat: 25.0, lng: 121.0, heading: 0, posTime: 1000, squawk: null, callsign: 'OLD1',
        }));
        // Rejected position (older posTime) but a real new squawk/callsign.
        const incoming = plane({
            lat: 30.0, lng: 130.0, posTime: 990, squawk: '7700', callsign: 'NEW1',
        });
        mergeStates([incoming], 'upsert');
        const merged = masterStateMap.get('abc123');
        expect(merged.lat).toBe(25.0); // position held back
        expect(merged.lng).toBe(121.0);
        expect(merged.squawk).toBe('7700'); // but squawk/callsign still updates
        expect(merged.callsign).toBe('NEW1');
    });

    test('ignores records missing lat/lng entirely', () => {
        mergeStates([plane({ lat: undefined, lng: undefined })], 'upsert');
        expect(masterStateMap.size).toBe(0);
    });
});
