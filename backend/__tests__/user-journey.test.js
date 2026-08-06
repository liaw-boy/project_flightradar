'use strict';
/**
 * AEROSTRAT — User Journey & Realistic Scenario Tests
 * 模擬真實用戶操作流程，而非只測試單一 endpoint
 */

const BASE = 'http://localhost:3000';

async function get(path) {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(8000) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

// ─────────────────────────────────────────────
// JOURNEY 1: 用戶打開地圖，點擊一架飛機
// 模擬前端 handleSelectPlane() 的完整流程
// ─────────────────────────────────────────────
describe('Journey 1: 點擊飛機 → 完整側欄資料', () => {
    let samplePlane = null;

    beforeAll(async () => {
        // 先抓一架真實在飛的飛機
        const { body } = await get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125');
        const planes = (body?.states || []).filter(p => p.callsign && p.callsign !== 'N/A' && !p.onGround);
        samplePlane = planes[0] || null;
    }, 15000);

    test('Step 1: bbox 回傳台灣上空飛機', async () => {
        const { status, body } = await get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125');
        expect(status).toBe(200);
        expect(body.states.length).toBeGreaterThan(0);
    }, 15000);

    test('Step 2: 查詢飛機路線 (callsign lookup)', async () => {
        if (!samplePlane) return;
        const { status, body } = await get(`/api/lookup/callsign/${samplePlane.callsign}`);
        expect(status).toBe(200);
        expect(body).toBeTruthy();
        // found 或 not found 都合理，重點是不能 crash
        expect(typeof body.found).toBe('boolean');
    }, 10000);

    test('Step 3: 查詢飛機 metadata (型號/航空公司)', async () => {
        if (!samplePlane) return;
        const { status, body } = await get(`/api/metadata/${samplePlane.icao24}`);
        expect(status).toBe(200);
        expect(body).toBeTruthy();
    }, 10000);

    test('Step 4: 查詢飛機路線 by ICAO24', async () => {
        if (!samplePlane) return;
        const { status, body } = await get(`/api/route/${samplePlane.icao24}?callsign=${samplePlane.callsign}`);
        expect(status).toBe(200);
        expect(body.icao24).toBe(samplePlane.icao24.toLowerCase());
        // source 不應該是 none（我們新增了 adsbdb 層）
        // 但 noData 還是有可能，重點是不能回 5xx
    }, 10000);

    test('Step 5: 查詢飛機照片', async () => {
        if (!samplePlane) return;
        const { status } = await get(`/api/photos/${samplePlane.icao24}`);
        expect([200, 404]).toContain(status);
    }, 10000);

    test('Step 6: 查詢航班軌跡', async () => {
        if (!samplePlane) return;
        const { status } = await get(`/api/flight-trace/${samplePlane.icao24}`);
        expect([200, 404]).toContain(status);
    }, 10000);
});

// ─────────────────────────────────────────────
// JOURNEY 2: 已知航班的路線正確性驗證
// 重點測試之前的 CX451 NRT→HKG bug 類型問題
// ─────────────────────────────────────────────
describe('Journey 2: 已知航班路線正確性', () => {
    const KNOWN_ROUTES = [
        // { callsign, expectedDep, expectedArr }
        { callsign: 'CPA451', expectedDep: 'TPE', expectedArr: 'HKG' }, // 之前 bug：顯示 NRT→HKG
        { callsign: 'JAL31',  expectedDep: null,  expectedArr: null   }, // 只確認有回傳，不限定值
        { callsign: 'EVA211', expectedDep: null,  expectedArr: null   },
    ];

    for (const route of KNOWN_ROUTES) {
        test(`${route.callsign} 路線資料正確`, async () => {
            const { status, body } = await get(`/api/lookup/callsign/${route.callsign}`);
            expect(status).toBe(200);

            if (route.expectedDep) {
                expect(body.dep_iata).toBe(route.expectedDep);
            }
            if (route.expectedArr) {
                expect(body.arr_iata).toBe(route.expectedArr);
            }

            // 核心：不能回傳 VrsDb 多段航線的頭尾（例如 CPA451 的 RJAA）
            if (route.callsign === 'CPA451') {
                expect(body.dep_iata).not.toBe('NRT');
                expect(body.dep_iata).not.toBe('RJAA'); // NRT 的 ICAO
            }
        }, 10000);
    }
});

// ─────────────────────────────────────────────
// JOURNEY 3: 資料管線健康度
// ─────────────────────────────────────────────
describe('Journey 3: 資料管線健康度', () => {
    test('全球 ADS-B 資料有在更新（5 分鐘內）', async () => {
        const { body } = await get('/api/data-freshness');
        // globalLastUpdate 應在 5 分鐘內
        const lastUpdate = body?.globalLastUpdate || body?.lastUpdate;
        if (!lastUpdate) return; // 如果 endpoint 沒有這個欄位就跳過
        const age = Date.now() - new Date(lastUpdate).getTime();
        expect(age).toBeLessThan(5 * 60 * 1000);
    });

    test('bbox 資料不 stale（超過 60 秒視為過期）', async () => {
        const { body } = await get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125');
        // stale=true 表示資料來自過期快取
        expect(body.stale).not.toBe(true);
    }, 15000);

    test('bbox 飛機座標全部在合理範圍（-90~90 lat, -180~180 lng）', async () => {
        const { body } = await get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125');
        for (const p of (body.states || [])) {
            expect(p.lat).toBeGreaterThanOrEqual(-90);
            expect(p.lat).toBeLessThanOrEqual(90);
            expect(p.lng).toBeGreaterThanOrEqual(-180);
            expect(p.lng).toBeLessThanOrEqual(180);
        }
    }, 15000);

    test('ICAO24 格式全部正確（6 位 hex）', async () => {
        const { body } = await get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125');
        for (const p of (body.states || [])) {
            expect(p.icao24).toMatch(/^[0-9a-f]{6}$/i);
        }
    }, 15000);
});

// ─────────────────────────────────────────────
// JOURNEY 4: 效能基準
// ─────────────────────────────────────────────
describe('Journey 4: 效能基準', () => {
    test('bbox API 回應 < 3000ms', async () => {
        const t0 = Date.now();
        await get('/api/planes/bbox?lamin=20&lomin=118&lamax=27&lomax=125');
        expect(Date.now() - t0).toBeLessThan(3000);
    }, 15000);

    test('ping < 100ms', async () => {
        const t0 = Date.now();
        await get('/api/ping');
        expect(Date.now() - t0).toBeLessThan(100);
    });

    test('airport lookup < 200ms（本地 DB，不應外呼）', async () => {
        const t0 = Date.now();
        await get('/api/lookup/airport/RCTP');
        expect(Date.now() - t0).toBeLessThan(200);
    });

    test('callsign lookup 含 adsbdb（< 6000ms）', async () => {
        const t0 = Date.now();
        await get('/api/lookup/callsign/CPA451');
        expect(Date.now() - t0).toBeLessThan(6000);
    }, 10000);
});

// ─────────────────────────────────────────────
// JOURNEY 5: 邊界條件與防崩潰
// ─────────────────────────────────────────────
describe('Journey 5: 邊界條件防崩潰', () => {
    test('超長 callsign 不崩潰', async () => {
        const { status } = await get('/api/lookup/callsign/AAAAAAAAAAAAAAAAAAAAAAAAA');
        expect([200, 400]).toContain(status);
    });

    test('特殊字元 callsign 不崩潰', async () => {
        const { status } = await get('/api/lookup/callsign/CX%20451');
        expect([200, 400]).toContain(status);
    });

    test('bbox 超大範圍不崩潰', async () => {
        const { status } = await get('/api/planes/bbox?lamin=-90&lomin=-180&lamax=90&lomax=180');
        expect([200, 400]).toContain(status);
    }, 15000);

    test('metadata 批次 POST 空陣列不崩潰', async () => {
        const res = await fetch(`${BASE}/api/metadata/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ icaos: [] }),
            signal: AbortSignal.timeout(5000),
        });
        expect([200, 400]).toContain(res.status);
    });

    test('photos 不存在的 ICAO → 200 或 404，不 500', async () => {
        const { status } = await get('/api/photos/000000');
        expect([200, 404]).toContain(status);
    }, 8000);

    test('airline lookup 無效 callsign → 不 500', async () => {
        const { status } = await get('/api/airline/ZZZZZ');
        expect([200, 404]).toContain(status);
    });
});
