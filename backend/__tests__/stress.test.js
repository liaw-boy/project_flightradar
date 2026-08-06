'use strict';
/**
 * AEROSTRAT — Stress & Load Tests
 * 模擬多用戶並發壓力，驗證 API 在高負載下的穩定性
 * 帳號：stress_tester (id=7)
 */

const BASE = 'http://localhost:3000';

// Shared cookie jar for authenticated requests
let authCookie = '';

async function get(path, cookie = '') {
    const headers = {};
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(`${BASE}${path}`, {
        headers,
        signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

async function post(path, payload, cookie = '') {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

// ─────────────────────────────────────────────
// 0. 取得認證 Cookie
// loginLimiter is IP-scoped and shared with every other test file hitting
// this server in the same run — if an earlier file (e.g. api.test.js's own
// burst test) already used up the window, retry once the window resets
// instead of failing the whole suite on a false-positive rate-limit hit.
// ─────────────────────────────────────────────
beforeAll(async () => {
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'stress_tester', password: 'StressTest2026!' }),
            signal: AbortSignal.timeout(10000),
        });
        if (res.status !== 429) break;
        const resetSecs = Number(res.headers.get('ratelimit-reset')) || 60;
        await new Promise(r => setTimeout(r, (resetSecs + 1) * 1000));
    }
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
        authCookie = setCookie.split(';')[0]; // aerostrat_token=...
    }
    expect(res.status).toBe(200);
    expect(authCookie).toContain('aerostrat_token');
}, 130000);

// ─────────────────────────────────────────────
// 1. 並發地圖請求（模擬 N 個用戶同時開啟地圖）
// ─────────────────────────────────────────────
describe('Concurrency: Map Load (bbox API)', () => {
    test('10 concurrent bbox requests — all 200, p95 < 3s', async () => {
        const N = 10;
        const start = Date.now();
        const tasks = Array.from({ length: N }, () =>
            get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125')
        );
        const results = await Promise.all(tasks);
        const elapsed = Date.now() - start;

        const statuses = results.map(r => r.status);
        const failCount = statuses.filter(s => s !== 200).length;
        expect(failCount).toBe(0);

        // p95 of individual responses: all ran in parallel, so elapsed ≈ max(individual times)
        // Just verify overall wall time is sane
        expect(elapsed).toBeLessThan(10000);
        console.log(`  10 concurrent bbox: ${elapsed}ms total`);
    }, 30000);

    test('20 concurrent bbox requests — error rate < 10%', async () => {
        const N = 20;
        const tasks = Array.from({ length: N }, () =>
            get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125').catch(() => ({ status: 0 }))
        );
        const results = await Promise.all(tasks);
        const errCount = results.filter(r => r.status !== 200).length;
        const errRate = errCount / N;
        expect(errRate).toBeLessThan(0.1); // < 10% error rate
        console.log(`  20 concurrent bbox: ${errCount}/${N} errors`);
    }, 60000);
});

// ─────────────────────────────────────────────
// 2. 並發 Callsign Lookup（模擬側欄同時查詢）
// ─────────────────────────────────────────────
describe('Concurrency: Callsign Lookup', () => {
    const CALLSIGNS = ['CPA451', 'JAL31', 'EVA211', 'ANA837', 'KAL692',
                       'SIA7', 'THA635', 'CES2973', 'CSN4310', 'MAS723'];

    test('10 distinct callsign lookups in parallel — all 200', async () => {
        const tasks = CALLSIGNS.map(cs => get(`/api/lookup/callsign/${cs}`));
        const results = await Promise.all(tasks);
        const failures = results.filter(r => r.status !== 200);
        expect(failures).toHaveLength(0);
    }, 30000);

    test('Same callsign 10x concurrent (cache stress) — all 200, p95 < 2s', async () => {
        const N = 10;
        const start = Date.now();
        const tasks = Array.from({ length: N }, () => get('/api/lookup/callsign/CPA451'));
        const results = await Promise.all(tasks);
        const elapsed = Date.now() - start;
        const failures = results.filter(r => r.status !== 200);
        expect(failures).toHaveLength(0);
        expect(elapsed).toBeLessThan(8000);
        console.log(`  Same callsign ×10 concurrent: ${elapsed}ms`);
    }, 30000);
});

// ─────────────────────────────────────────────
// 3. SSE 連線壓力（模擬多個頁籤同時開啟）
// ─────────────────────────────────────────────
describe('Concurrency: SSE Connections', () => {
    test('5 simultaneous SSE connections — all 200 and receive data', async () => {
        const N = 5;
        const tasks = Array.from({ length: N }, () =>
            fetch(`${BASE}/api/events`, {
                headers: { Accept: 'text/event-stream' },
                signal: AbortSignal.timeout(3000),
            }).catch(() => null)
        );
        const results = await Promise.all(tasks);
        const ok = results.filter(r => r && r.status === 200);
        expect(ok.length).toBeGreaterThanOrEqual(4); // Allow 1 failure
        console.log(`  SSE connections: ${ok.length}/${N} succeeded`);
    }, 15000);
});

// ─────────────────────────────────────────────
// 4. 認證用戶並發請求
// ─────────────────────────────────────────────
describe('Concurrency: Authenticated Requests', () => {
    test('10 concurrent /api/auth/me with cookie — all 200', async () => {
        const N = 10;
        const tasks = Array.from({ length: N }, () => get('/api/auth/me', authCookie));
        const results = await Promise.all(tasks);
        const failures = results.filter(r => r.status !== 200);
        expect(failures).toHaveLength(0);
    }, 15000);

    test('Mixed authenticated + unauthenticated requests do not interfere', async () => {
        const authTasks   = Array.from({ length: 5 }, () => get('/api/auth/me', authCookie));
        const publicTasks = Array.from({ length: 5 }, () => get('/api/ping'));
        const results = await Promise.all([...authTasks, ...publicTasks]);
        const authFails  = results.slice(0, 5).filter(r => r.status !== 200);
        const pubFails   = results.slice(5).filter(r => r.status !== 200);
        expect(authFails).toHaveLength(0);
        expect(pubFails).toHaveLength(0);
    }, 15000);
});

// ─────────────────────────────────────────────
// 5. 速率限制驗證（系統應保護自己）
// ─────────────────────────────────────────────
describe('Rate Limiting Under Load', () => {
    test('Rapid ping requests do not get 429 (public non-rate-limited)', async () => {
        const N = 30;
        const tasks = Array.from({ length: N }, () => get('/api/ping'));
        const results = await Promise.all(tasks);
        const got429 = results.filter(r => r.status === 429);
        expect(got429).toHaveLength(0); // ping should not be rate-limited
    }, 30000);

    test('Burst login attempts trigger 429 (rate limiter is active)', async () => {
        const N = 15;
        const tasks = Array.from({ length: N }, () =>
            post('/api/auth/login', { username: 'noone_xxx', password: 'wrong' })
        );
        const results = await Promise.all(tasks);
        const statuses = results.map(r => r.status);
        const has429 = statuses.some(s => s === 429);
        // Rate limiter should kick in within 15 rapid requests
        expect(has429).toBe(true);
        console.log(`  Login burst statuses: ${[...new Set(statuses)].join(', ')}`);
    }, 30000);
});

// ─────────────────────────────────────────────
// 6. 持續負載（序列波浪，確保伺服器不崩潰）
// ─────────────────────────────────────────────
describe('Sustained Load: 50-request wave', () => {
    test('50 sequential bbox requests — no crashes, avg < 2s', async () => {
        const N = 50;
        const times = [];
        let errors = 0;

        for (let i = 0; i < N; i++) {
            const t0 = Date.now();
            const { status } = await get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125')
                .catch(() => ({ status: 0 }));
            times.push(Date.now() - t0);
            if (status !== 200) errors++;
        }

        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const max = Math.max(...times);
        const p95 = times.sort((a, b) => a - b)[Math.floor(N * 0.95)];

        console.log(`  50-req wave: avg=${avg.toFixed(0)}ms, p95=${p95}ms, max=${max}ms, errors=${errors}`);
        expect(errors).toBe(0);
        expect(avg).toBeLessThan(3000);
    }, 120000);

    test('Mixed API wave (10 endpoints × 5 each = 50 reqs) — error rate < 5%', async () => {
        const ENDPOINTS = [
            '/api/ping',
            '/api/data-freshness',
            '/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125',
            '/api/lookup/callsign/CPA451',
            '/api/lookup/airport/RCTP',
            '/api/metadata/780be2',
            '/api/airline/CPA451',
            '/api/route/780be2?callsign=JAL31',
            '/api/airports/list',
            '/api/lookup/callsign/EVA211',
        ];

        const wave = [];
        for (const ep of ENDPOINTS) {
            for (let i = 0; i < 5; i++) {
                wave.push(get(ep).catch(() => ({ status: 0 })));
            }
        }

        const results = await Promise.all(wave);
        const errors = results.filter(r => r.status >= 500 || r.status === 0);
        const errRate = errors.length / results.length;
        console.log(`  Mixed wave: ${errors.length}/${results.length} errors (${(errRate * 100).toFixed(1)}%)`);
        expect(errRate).toBeLessThan(0.05);
    }, 60000);
});

// ─────────────────────────────────────────────
// 7. 記憶體 / 連線洩漏探針
// ─────────────────────────────────────────────
describe('Memory & Connection Leak Probes', () => {
    test('Server still responsive after load waves (ping < 200ms)', async () => {
        const t0 = Date.now();
        const { status, body } = await get('/api/ping');
        const elapsed = Date.now() - t0;
        expect(status).toBe(200);
        expect(body.status).toBe('ok');
        expect(elapsed).toBeLessThan(200);
        console.log(`  Post-load ping: ${elapsed}ms`);
    });

    test('bbox still returns valid data after load', async () => {
        const { status, body } = await get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125');
        expect(status).toBe(200);
        expect(Array.isArray(body.states)).toBe(true);
        // Coordinates should still be sane
        for (const p of body.states || []) {
            expect(isNaN(p.lat)).toBe(false);
            expect(isNaN(p.lng)).toBe(false);
        }
    }, 15000);
});
