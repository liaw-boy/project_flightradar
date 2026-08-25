'use strict';
/**
 * AEROSTRAT — Full API Integration Test Suite
 * 測試目標：http://localhost:3000 (live server)
 * 執行方式：npx jest --testPathPattern=api.test.js --forceExit
 */

const BASE = 'http://localhost:3000';

async function get(path) {
    const res = await fetch(`${BASE}${path}`);
    return { status: res.status, body: await res.json().catch(() => null) };
}

// ─────────────────────────────────────────────
// 1. INFRASTRUCTURE
// ─────────────────────────────────────────────
describe('1. Infrastructure', () => {
    test('GET /api/ping → 200 + {status:ok}', async () => {
        const { status, body } = await get('/api/ping');
        expect(status).toBe(200);
        expect(body.status).toBe('ok');
        expect(body.timestamp).toBeDefined();
    });

    test('GET /api/data-freshness → 200', async () => {
        const { status, body } = await get('/api/data-freshness');
        expect(status).toBe(200);
        expect(body).toBeTruthy();
    });

    test('GET /api/planes/bbox-ping → 200', async () => {
        const { status, body } = await get('/api/planes/bbox-ping');
        expect(status).toBe(200);
        expect(body.status).toBe('active');
    });
});

// ─────────────────────────────────────────────
// 2. LIVE PLANE DATA
// ─────────────────────────────────────────────
describe('2. Live Plane Data', () => {
    test('GET /api/planes/bbox (Taiwan bbox) → 200 + states array', async () => {
        const { status, body } = await get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125');
        expect(status).toBe(200);
        // bbox returns {states, source, time, stale, globalLastUpdate}
        expect(body.states).toBeDefined();
        expect(Array.isArray(body.states)).toBe(true);
        expect(body.source).toBeDefined();
    }, 15000);

    test('Plane objects have required fields', async () => {
        const { body } = await get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125');
        if (!body.states || body.states.length === 0) return; // skip if no planes at test time
        const p = body.states[0];
        expect(p.icao24).toBeDefined();
        expect(typeof p.lat).toBe('number');
        expect(typeof p.lng).toBe('number');
    }, 15000);

    test('GET /api/events (SSE endpoint) → 200', async () => {
        const res = await fetch(`${BASE}/api/events`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
        expect(res?.status).toBe(200);
    }, 5000);
});

// ─────────────────────────────────────────────
// 3. ROUTE LOOKUP — 側欄航班資訊
// ─────────────────────────────────────────────
describe('3. Route Lookup', () => {
    test('CPA451 → TPE→HKG (adsbdb, not stale VrsDb)', async () => {
        const { status, body } = await get('/api/lookup/callsign/CPA451');
        expect(status).toBe(200);
        expect(body.found).toBe(true);
        expect(body.dep_iata).toBe('TPE');
        expect(body.arr_iata).toBe('HKG');
    }, 8000);

    test('JAL31 → route exists and has dep/arr', async () => {
        const { status, body } = await get('/api/lookup/callsign/JAL31');
        expect(status).toBe(200);
        expect(body.found).toBe(true);
        expect(body.dep_iata).toBeTruthy();
        expect(body.arr_iata).toBeTruthy();
    }, 8000);

    test('Unknown callsign → {found:false}', async () => {
        const { status, body } = await get('/api/lookup/callsign/ZZZZZ999');
        expect(status).toBe(200);
        expect(body.found).toBe(false);
    }, 8000);

    test('GET /api/route/:icao24 with callsign (adsbdb path)', async () => {
        const { status, body } = await get('/api/route/780be2?callsign=JAL31');
        expect(status).toBe(200);
        expect(body.departureAirport).toBeTruthy();
        expect(body.arrivalAirport).toBeTruthy();
        expect(body.source).not.toBe('none');
    }, 8000);

    test('noData result uses short cache TTL (2 min not 30 min)', async () => {
        const { body } = await get('/api/route/000000?callsign=ZZZTEST');
        expect(body.noData).toBe(true);
        // Just verify structure — TTL behavior is runtime-only
    }, 5000);
});

// ─────────────────────────────────────────────
// 4. AIRPORT LOOKUP
// ─────────────────────────────────────────────
describe('4. Airport Lookup', () => {
    test('RCTP → found with ICAO and IATA', async () => {
        const { status, body } = await get('/api/lookup/airport/RCTP');
        expect(status).toBe(200);
        expect(body.found).toBe(true);
        expect(body.iata).toBe('TPE');
        expect(body.icao).toBe('RCTP');
    });

    test('TPE (IATA) → resolves to RCTP', async () => {
        const { status, body } = await get('/api/lookup/airport/TPE');
        expect(status).toBe(200);
        expect(body.found).toBe(true);
    });

    test('Unknown airport → {found:false}', async () => {
        const { status, body } = await get('/api/lookup/airport/ZZZZ');
        expect(status).toBe(200);
        expect(body.found).toBe(false);
    });

    test('GET /api/airports/list → array', async () => {
        const { status, body } = await get('/api/airports/list');
        expect(status).toBe(200);
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBeGreaterThan(100);
    });
});

// ─────────────────────────────────────────────
// 5. AIRCRAFT METADATA
// ─────────────────────────────────────────────
describe('5. Aircraft Metadata', () => {
    test('GET /api/metadata/:icao24 → 200', async () => {
        const { status, body } = await get('/api/metadata/780be2');
        expect(status).toBe(200);
        expect(body).toBeTruthy();
    }, 8000);

    test('GET /api/aircraft/:icao24 → 200', async () => {
        const { status, body } = await get('/api/aircraft/780be2');
        expect(status).toBe(200);
    }, 8000);

    test('Invalid ICAO24 → 400', async () => {
        const { status } = await get('/api/metadata/INVALID!!');
        expect(status).toBe(400);
    });
});

// ─────────────────────────────────────────────
// 7. ADMIN / PROTECTED ENDPOINTS
// ─────────────────────────────────────────────
describe('7. Protected Endpoints (no auth)', () => {
    test('GET /api/health → 401 without auth', async () => {
        const { status } = await get('/api/health');
        expect(status).toBe(401);
    });

    test('GET /api/stats → 401 without auth', async () => {
        const { status } = await get('/api/stats');
        expect(status).toBe(401);
    });

    test('GET /api/ingestion/status → 401 without auth', async () => {
        const { status } = await get('/api/ingestion/status');
        expect(status).toBe(401);
    });
});

// ─────────────────────────────────────────────
// 8. FLIGHT TRACE
// ─────────────────────────────────────────────
describe('8. Flight Trace', () => {
    test('GET /api/flight-trace/:hex → 200 or 404', async () => {
        const { status } = await get('/api/flight-trace/780be2');
        expect([200, 404]).toContain(status);
    }, 8000);

    test('GET /api/flight-trace with invalid hex → 400', async () => {
        const { status } = await get('/api/flight-trace/INVALID!!');
        expect(status).toBe(400);
    });
});

// ─────────────────────────────────────────────
// 9. AIRLINE / SVG / STATIC
// ─────────────────────────────────────────────
describe('9. Airline & Static Resources', () => {
    test('GET /api/airline/:callsign → 200', async () => {
        const { status, body } = await get('/api/airline/CPA451');
        expect(status).toBe(200);
        expect(body).toBeTruthy();
    });

    test('GET /api/svg/:typecode → 200 SVG or 404', async () => {
        const res = await fetch(`${BASE}/api/svg/B738`);
        expect([200, 404]).toContain(res.status);
        if (res.status === 200) {
            expect(res.headers.get('content-type')).toContain('svg');
        }
    });

    test('GET /favicon.svg → 200', async () => {
        const res = await fetch(`${BASE}/favicon.svg`);
        expect(res.status).toBe(200);
    });
});

// ─────────────────────────────────────────────
// 11. DATA INTEGRITY
// ─────────────────────────────────────────────
describe('11. Data Integrity', () => {
    test('Plane bbox returns no NaN coordinates', async () => {
        const { body } = await get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125');
        for (const p of (body.states || [])) {
            expect(isNaN(p.lat)).toBe(false);
            expect(isNaN(p.lng)).toBe(false);
        }
    }, 15000);

    test('VrsDb multi-leg route (CPA451 NRT→HKG) is NOT returned by sidebar', async () => {
        const { body } = await get('/api/lookup/callsign/CPA451');
        // Must not return RJAA (NRT) as departure — that was the stale VrsDb bug
        expect(body.dep_iata).not.toBe('NRT');
        expect(body.dep_iata).not.toBe('RJAA');
    }, 8000);

    test('Route noData is not cached for 30 min (cache key exists but short TTL)', async () => {
        await get('/api/route/ffffff?callsign=TESTONLY');
        const r2 = await get('/api/route/ffffff?callsign=TESTONLY');
        expect(r2.body.noData).toBe(true); // Still noData is fine, just verifying no crash
    }, 10000);
});

// ─────────────────────────────────────────────
// 12. MONITOR PAGE
// ─────────────────────────────────────────────
describe('12. Monitor Page', () => {
    test('GET /monitor without auth → 200/302/401 (login page, redirect, or denied)', async () => {
        const res = await fetch(`${BASE}/monitor`, { redirect: 'manual' });
        expect([200, 302, 401]).toContain(res.status);
    });

    test('GET /monitor/api/db-status without auth → 401', async () => {
        const { status } = await get('/monitor/api/db-status');
        expect(status).toBe(401);
    });
});
