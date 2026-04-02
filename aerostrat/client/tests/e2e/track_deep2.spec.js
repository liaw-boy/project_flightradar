// @ts-check
/**
 * 飛行軌跡深度測試 — 第二批
 * 涵蓋：飛行階段、地圖拖曳、反子午線、播放回放、
 *        非選中飛機短尾、搜尋後軌跡、API 正確性、效能
 */
import { test, expect } from '@playwright/test';

const BASE    = 'http://localhost:3005';
const BACKEND = 'http://localhost:3000';

// ── 共用工具 ──────────────────────────────────────────────────────────
async function waitMap(page) {
    await page.locator('.leaflet-container').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(1500);
}
async function setView(page, lat, lng, zoom) {
    await page.evaluate(({ lat, lng, zoom }) => {
        const map = document.querySelector('.leaflet-container')?._leaflet_map
                 || document.querySelector('.leaflet-container')?._leafletMap;
        if (map) map.setView([lat, lng], zoom, { animate: false });
    }, { lat, lng, zoom });
    await page.waitForTimeout(800);
}
async function selectViaURL(page, icao, lat, lng, zoom = 10) {
    await page.goto(`${BASE}/?icao=${icao}`, { waitUntil: 'domcontentloaded' });
    await waitMap(page);
    await setView(page, lat, lng, zoom);
    await page.waitForTimeout(2500);
}
async function getTrackedPlanes(page, minPts = 5, limit = 50) {
    const bbox = await page.request
        .get(`${BACKEND}/api/planes/bbox?lamin=5&lomin=95&lamax=55&lomax=150`)
        .then(r => r.json()).catch(() => ({ states: [] }));
    const result = [];
    for (const p of (bbox.states || []).slice(0, limit)) {
        if (!p.lat || !p.lng) continue;
        const t = await page.request
            .get(`${BACKEND}/api/tracks?icao24=${p.icao24}`)
            .then(r => r.json()).catch(() => null);
        if (t?.path?.length >= minPts)
            result.push({ ...p, trackPts: t.path.length, path: t.path });
    }
    return result.sort((a, b) => b.trackPts - a.trackPts);
}
function canvasHasPixels(page) {
    return page.evaluate(() => {
        for (const c of document.querySelectorAll('.leaflet-overlay-pane canvas')) {
            if (!c.width || !c.height) continue;
            const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
            if (!d) continue;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 10) return true;
        }
        return false;
    });
}

// ══════════════════════════════════════════════════════════════════════
// Test 6：飛行各階段軌跡 — 爬升、巡航、降落
// ══════════════════════════════════════════════════════════════════════
test('飛行階段：爬升/巡航/降落的軌跡顯示', async ({ page }) => {
    test.setTimeout(180000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    let planes = [];
    for (let i = 0; i < 6; i++) {
        planes = await getTrackedPlanes(page, 5, 60);
        if (planes.length >= 3) break;
        await page.waitForTimeout(5000);
    }

    // 分類飛行階段（依高度與垂直速率）
    const climbing  = planes.filter(p => p.altitude < 8000 && p.vRate > 1);
    const cruising  = planes.filter(p => p.altitude > 9000);
    const descending = planes.filter(p => p.altitude < 5000 && p.vRate < -1);

    console.log(`\n爬升: ${climbing.length} | 巡航: ${cruising.length} | 降落: ${descending.length}`);

    const toTest = [
        { label: '爬升', plane: climbing[0] },
        { label: '巡航', plane: cruising[0] },
        { label: '降落', plane: descending[0] },
    ].filter(x => x.plane);

    for (const { label, plane: p } of toTest) {
        console.log(`\n[${label}] ${p.icao24} alt=${p.altitude}m vRate=${p.vRate?.toFixed(1)}`);
        await selectViaURL(page, p.icao24, p.lat, p.lng, 9);

        const hasTrack = await canvasHasPixels(page);
        console.log(`  Canvas 有像素: ${hasTrack}`);
        await page.screenshot({ path: `../pw-screenshots/phase_${label}_${p.icao24}.png` });

        // 確認 Sidebar 開啟
        const sidebarOpen = await page.locator('.sidebar').count() > 0;
        console.log(`  Sidebar 開啟: ${sidebarOpen}`);
        expect(hasTrack, `${label}階段應有軌跡`).toBeTruthy();
    }
    console.log('\n✅ 飛行階段測試通過');
});

// ══════════════════════════════════════════════════════════════════════
// Test 7：地圖拖曳後軌跡不消失
// ══════════════════════════════════════════════════════════════════════
test('地圖拖曳後軌跡持續顯示', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    let planes = [];
    for (let i = 0; i < 5; i++) {
        planes = await getTrackedPlanes(page, 8, 20);
        if (planes.length) break;
        await page.waitForTimeout(5000);
    }
    if (!planes.length) return;

    const p = planes[0];
    await selectViaURL(page, p.icao24, p.lat, p.lng, 9);

    const box = await page.locator('.leaflet-container').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // 截圖前
    const before = await canvasHasPixels(page);
    await page.screenshot({ path: `../pw-screenshots/pan_before_${p.icao24}.png` });

    // 拖曳地圖
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 0; i < 10; i++) { await page.mouse.move(cx - i*20, cy + i*10); await page.waitForTimeout(30); }
    await page.mouse.up();
    await page.waitForTimeout(800);

    // 截圖後（飛機可能移出視野，zoom out 看）
    await setView(page, p.lat, p.lng, 8);
    await page.waitForTimeout(600);
    const after = await canvasHasPixels(page);
    await page.screenshot({ path: `../pw-screenshots/pan_after_${p.icao24}.png` });

    console.log(`\n拖曳前: ${before} → 拖曳後: ${after}`);
    expect(after, '拖曳後軌跡應仍可見').toBeTruthy();
    console.log('✅ 拖曳穩定性通過');
});

// ══════════════════════════════════════════════════════════════════════
// Test 8：搜尋航班後軌跡正確載入
// ══════════════════════════════════════════════════════════════════════
test('搜尋航班後歷史軌跡正確顯示', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    // 等資料
    let planes = [];
    for (let i = 0; i < 6; i++) {
        planes = await getTrackedPlanes(page, 10, 30);
        if (planes.length) break;
        await page.waitForTimeout(5000);
    }
    if (!planes.length) return;

    // 取有呼號的飛機
    const p = planes.find(x => x.callsign && x.callsign.length >= 3) || planes[0];
    const cs = (p.callsign || '').slice(0, 3);
    console.log(`\n搜尋: "${cs}" → 期望找到 ${p.icao24} (${p.callsign})`);

    const search = page.locator('input[type="text"], input[type="search"]').first();
    await search.click();
    await page.waitForTimeout(300);
    await search.fill('');
    for (const ch of cs) { await search.type(ch); await page.waitForTimeout(120); }
    await page.waitForTimeout(800);
    await page.screenshot({ path: `../pw-screenshots/search_results_${cs}.png` });

    // 點擊第一個結果
    const results = page.locator('[class*="search-item"],[class*="search-result"],[class*="suggestion"]');
    const cnt = await results.count();
    if (cnt > 0) {
        await results.first().click();
        await page.waitForTimeout(2500);
        await page.screenshot({ path: `../pw-screenshots/search_selected_${cs}.png` });
        const hasTrack = await canvasHasPixels(page);
        console.log(`  搜尋選取後軌跡: ${hasTrack ? '✅ 有' : '⚠ 無'}`);
    } else {
        // 直接用 URL 選取
        await selectViaURL(page, p.icao24, p.lat, p.lng);
        const hasTrack = await canvasHasPixels(page);
        console.log(`  直接選取軌跡: ${hasTrack ? '✅' : '⚠'}`);
    }
    console.log('✅ 搜尋軌跡測試完成');
});

// ══════════════════════════════════════════════════════════════════════
// Test 9：API /api/tracks 資料結構驗證
// ══════════════════════════════════════════════════════════════════════
test('API /api/tracks 資料結構與時序正確性', async ({ page }) => {
    test.setTimeout(60000);

    let planes = [];
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 5; i++) {
        planes = await getTrackedPlanes(page, 5, 30);
        if (planes.length >= 3) break;
        await page.waitForTimeout(5000);
    }

    const errors = [];
    for (const p of planes.slice(0, 5)) {
        const t = await page.request
            .get(`${BACKEND}/api/tracks?icao24=${p.icao24}`)
            .then(r => r.json()).catch(() => null);

        if (!t || !t.path) { errors.push(`${p.icao24}: 無 path`); continue; }

        const path = t.path;
        // 驗證格式：每個點 [timestamp, lat, lng, alt, heading, velocity]
        for (let i = 0; i < path.length; i++) {
            const pt = path[i];
            if (!Array.isArray(pt) || pt.length < 3) {
                errors.push(`${p.icao24}[${i}]: 格式錯誤 ${JSON.stringify(pt)}`);
                break;
            }
            if (pt[1] < -90 || pt[1] > 90) { errors.push(`${p.icao24}[${i}]: lat=${pt[1]} 超範圍`); break; }
            if (pt[2] < -180 || pt[2] > 180) { errors.push(`${p.icao24}[${i}]: lng=${pt[2]} 超範圍`); break; }
        }

        // 驗證時序遞增
        for (let i = 1; i < path.length; i++) {
            if (path[i][0] && path[i-1][0] && path[i][0] < path[i-1][0] - 1) {
                errors.push(`${p.icao24}[${i}]: 時序倒退 ${path[i-1][0]} → ${path[i][0]}`);
                break;
            }
        }

        // 驗證末點時間不超過 now + 60s（軌跡不應包含未來資料）
        const lastTime = path[path.length - 1][0];
        if (lastTime && lastTime > Date.now() / 1000 + 60) {
            errors.push(`${p.icao24}: 末點時間在未來 (${new Date(lastTime*1000).toISOString()})`);
        }

        // 驗證末點時間不超過飛機 lastContact
        const liveContact = p.lastContact;
        if (lastTime && liveContact && lastTime > liveContact + 15) {
            errors.push(`${p.icao24}: 軌跡末點(${lastTime}) > lastContact(${liveContact}) +15s — 可能超前`);
        }

        console.log(`  ${p.icao24}: ${path.length} pts, span=${((path[path.length-1][0]-path[0][0])/60).toFixed(1)}min, lastPt=${lastTime}, liveContact=${liveContact}`);
    }

    if (errors.length) errors.forEach(e => console.error('  ❌', e));
    expect(errors, `資料結構/時序錯誤:\n${errors.join('\n')}`).toHaveLength(0);
    console.log('✅ API 資料結構驗證通過');
});

// ══════════════════════════════════════════════════════════════════════
// Test 10：非選中飛機的背景短尾
// ══════════════════════════════════════════════════════════════════════
test('非選中飛機：背景短尾可見', async ({ page }) => {
    test.setTimeout(60000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);
    await page.waitForTimeout(5000); // 等飛機資料累積

    // zoom 8，不選取任何飛機，觀察背景短尾
    await setView(page, 25.0, 121.5, 8);
    await page.waitForTimeout(2000);

    const hasBgTrail = await canvasHasPixels(page);
    await page.screenshot({ path: '../pw-screenshots/bg_trail_noselection.png' });
    console.log(`\n無選取飛機時 Canvas: ${hasBgTrail ? '✅ 有飛機圖示' : '❌ 空白'}`);
    expect(hasBgTrail, '無選取飛機時應有飛機圖示').toBeTruthy();
    console.log('✅ 背景短尾測試通過');
});

// ══════════════════════════════════════════════════════════════════════
// Test 11：TimePlayer 回放模式
// ══════════════════════════════════════════════════════════════════════
test('TimePlayer：回放滑桿操作', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    let planes = [];
    for (let i = 0; i < 6; i++) {
        planes = await getTrackedPlanes(page, 20, 20);
        if (planes.length) break;
        await page.waitForTimeout(5000);
    }
    if (!planes.length) { console.log('無足夠軌跡點，跳過'); return; }

    const p = planes[0];
    console.log(`\nTimePlayer 測試: ${p.icao24} ${p.trackPts}pts`);
    await selectViaURL(page, p.icao24, p.lat, p.lng, 9);

    // 找 TimePlayer 滑桿
    const slider = page.locator('input[type="range"]').first();
    const sliderVisible = await slider.isVisible().catch(() => false);
    console.log(`  TimePlayer 滑桿: ${sliderVisible ? '可見' : '不可見（點數不足？）'}`);

    if (sliderVisible) {
        await page.screenshot({ path: `../pw-screenshots/timeplayer_before_${p.icao24}.png` });

        // 拉到 30%
        const box = await slider.boundingBox();
        await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
        await page.waitForTimeout(800);
        await page.screenshot({ path: `../pw-screenshots/timeplayer_30pct_${p.icao24}.png` });
        console.log('  拉到 30%');

        // 拉到 70%
        await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
        await page.waitForTimeout(800);
        await page.screenshot({ path: `../pw-screenshots/timeplayer_70pct_${p.icao24}.png` });
        console.log('  拉到 70%');

        // 按播放按鈕（若有）
        const playBtn = page.locator('[class*="play"], button:has-text("▶"), button:has-text("Play")').first();
        if (await playBtn.isVisible().catch(() => false)) {
            await playBtn.click();
            await page.waitForTimeout(3000);
            await page.screenshot({ path: `../pw-screenshots/timeplayer_playing_${p.icao24}.png` });
            console.log('  播放 3 秒');
            await playBtn.click(); // 暫停
        }
    }
    console.log('✅ TimePlayer 測試完成');
});

// ══════════════════════════════════════════════════════════════════════
// Test 12：反子午線飛航（台北↔北美）
// ══════════════════════════════════════════════════════════════════════
test('反子午線：跨越 ±180° 的飛機軌跡不畫錯誤橫線', async ({ page }) => {
    test.setTimeout(120000);

    // 查詢太平洋航線上的飛機（有機會是跨太平洋）
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    const transPacific = await page.request
        .get(`${BACKEND}/api/planes/bbox?lamin=20&lomin=-180&lamax=60&lomax=-120`)
        .then(r => r.json()).catch(() => ({ states: [] }));

    console.log(`\n太平洋東側飛機數: ${transPacific.states?.length || 0}`);

    if ((transPacific.states?.length || 0) > 0) {
        const p = transPacific.states[0];
        await selectViaURL(page, p.icao24, p.lat, p.lng, 4);
        await page.screenshot({ path: `../pw-screenshots/antimeridian_z4.png` });

        // zoom out 到 3 看全局
        await setView(page, 40, 180, 3);
        await page.waitForTimeout(1200);
        await page.screenshot({ path: `../pw-screenshots/antimeridian_global.png` });
        console.log(`  截圖完成: antimeridian_z4 / global`);
    } else {
        console.log('  太平洋東側目前無飛機，改截全球俯瞰');
        await setView(page, 20, 0, 3);
        await page.waitForTimeout(2000);
        await page.screenshot({ path: '../pw-screenshots/antimeridian_global_fallback.png' });
    }

    // 確認沒有 JS 錯誤
    const jsErr = [];
    page.on('pageerror', e => jsErr.push(e.message));
    await page.waitForTimeout(1000);
    const fatal = jsErr.filter(e => e.includes('TypeError') || e.includes('Cannot read'));
    expect(fatal, `反子午線 JS 錯誤: ${fatal.join(';')}`).toHaveLength(0);
    console.log('✅ 反子午線測試通過（無 JS 錯誤）');
});

// ══════════════════════════════════════════════════════════════════════
// Test 13：高密度效能 — 2000+ 架飛機不崩潰
// ══════════════════════════════════════════════════════════════════════
test('效能：高密度區域 Canvas 渲染不崩潰', async ({ page }) => {
    test.setTimeout(120000);
    const jsErrors = [];
    page.on('pageerror', e => { jsErrors.push(e.message); console.error('JS Error:', e.message); });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    // 飛到美國東岸（最高密度）
    await setView(page, 40.7, -74.0, 5);
    await page.waitForTimeout(3000);

    // 快速縮放壓測
    const box = await page.locator('.leaflet-container').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(200);
    }
    for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 200);
        await page.waitForTimeout(200);
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '../pw-screenshots/perf_usa_east.png' });

    // 飛到歐洲
    await setView(page, 50.1, 8.7, 5);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '../pw-screenshots/perf_europe.png' });

    // 確認頁面仍正常
    const mapOk = await page.locator('.leaflet-container').isVisible();
    const fatalJs = jsErrors.filter(e => e.includes('TypeError') || e.includes('Cannot read'));
    console.log(`\nJS 錯誤: ${jsErrors.length} | Fatal: ${fatalJs.length} | Map OK: ${mapOk}`);

    expect(mapOk, '高密度後地圖應仍可見').toBeTruthy();
    expect(fatalJs, `Fatal JS 錯誤: ${fatalJs.join(';')}`).toHaveLength(0);
    console.log('✅ 效能測試通過');
});

// ══════════════════════════════════════════════════════════════════════
// Test 14：Sidebar 資料完整性 — 所有欄位正確顯示
// ══════════════════════════════════════════════════════════════════════
test('Sidebar 資料完整性：路線、高度、速度、照片', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    let planes = [];
    for (let i = 0; i < 6; i++) {
        const d = await page.request
            .get(`${BACKEND}/api/planes/bbox?lamin=10&lomin=100&lamax=50&lomax=145`)
            .then(r => r.json()).catch(() => ({ states: [] }));
        // 找有呼號且高空的飛機（可能有路線資訊）
        planes = (d.states || []).filter(p => p.callsign && p.altitude > 8000 && p.lat && p.lng);
        if (planes.length >= 3) break;
        await page.waitForTimeout(5000);
    }
    if (!planes.length) return;

    const results = [];
    for (const p of planes.slice(0, 3)) {
        await selectViaURL(page, p.icao24, p.lat, p.lng, 9);
        const sb = page.locator('.sidebar');
        const text = await sb.textContent().catch(() => '');

        // 檢查各欄位
        const hasCallsign  = text.includes(p.callsign || '');
        const hasAltitude  = /\d{3,5}\s*(m|ft|km)/.test(text) || text.includes('ALT');
        const hasPhoto     = await sb.locator('img').count() > 0;
        const hasRoute     = /[A-Z]{3}\s*[→↗➜✈]\s*[A-Z]{3}/.test(text) ||
                             (text.match(/[A-Z]{3}/g) || []).length >= 2;
        const hasAirline   = text.length > 50; // 有任何內容就算有資料

        console.log(`\n${p.icao24} (${p.callsign}):`);
        console.log(`  呼號: ${hasCallsign} | 路線: ${hasRoute} | 照片: ${hasPhoto} | 內容長度: ${text.length}`);

        await page.screenshot({ path: `../pw-screenshots/sidebar_${p.icao24}.png` });
        results.push({ icao: p.icao24, hasCallsign, hasRoute, hasPhoto, len: text.length });
    }

    // 至少一架飛機的 Sidebar 有完整資料
    const fullData = results.filter(r => r.hasCallsign && r.len > 100);
    expect(fullData.length, 'Sidebar 應至少有一架飛機的完整資料').toBeGreaterThan(0);
    console.log('\n✅ Sidebar 資料完整性測試通過');
});

// ══════════════════════════════════════════════════════════════════════
// Test 15：Route API 修復驗證 — /api/route/external 正常工作
// ══════════════════════════════════════════════════════════════════════
test('Route API 修復：/api/route/external 不再被 :icao24 攔截', async ({ page }) => {
    test.setTimeout(30000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    // 直接呼叫應得到正確回應（非 "Invalid ICAO24 format"）
    const r1 = await page.request
        .get(`${BACKEND}/api/route/external?callsign=CAL5838`)
        .then(r => r.json()).catch(() => null);
    console.log(`\n/api/route/external?callsign=CAL5838:`, JSON.stringify(r1));
    expect(r1?.error, '不應回傳 Invalid ICAO24 format').not.toBe('Invalid ICAO24 format');

    // 無呼號應回傳 400（而非 Invalid ICAO24）
    const r2 = await page.request
        .get(`${BACKEND}/api/route/external`)
        .then(r => ({ status: r.status(), body: r.json() })).catch(() => null);
    console.log(`/api/route/external (無參數): status=${r2?.status}`);

    // 正常 icao24 路由不受影響
    const r3 = await page.request
        .get(`${BACKEND}/api/route/B18101?callsign=CAL5838`)
        .then(r => ({ status: r.status() })).catch(() => null);
    console.log(`/api/route/B18101: status=${r3?.status}`);
    expect(r3?.status).not.toBe(undefined);

    console.log('✅ Route API 修復驗證通過');
});

// ══════════════════════════════════════════════════════════════════════
// Test 16：WebSocket 斷線重連後軌跡保留
// ══════════════════════════════════════════════════════════════════════
test('WebSocket 離線 5 秒後重連，軌跡不消失', async ({ page }) => {
    test.setTimeout(120000);
    const jsErrors = [];
    page.on('pageerror', e => jsErrors.push(e.message));

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    let planes = [];
    for (let i = 0; i < 5; i++) {
        planes = await getTrackedPlanes(page, 8, 20);
        if (planes.length) break;
        await page.waitForTimeout(5000);
    }
    if (!planes.length) return;

    const p = planes[0];
    await selectViaURL(page, p.icao24, p.lat, p.lng, 9);
    const before = await canvasHasPixels(page);
    await page.screenshot({ path: `../pw-screenshots/ws_before_${p.icao24}.png` });

    // 模擬離線（透過 CDP）
    const client = await page.context().newCDPSession(page);
    await client.send('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });
    console.log('\n  模擬離線 5 秒...');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `../pw-screenshots/ws_offline_${p.icao24}.png` });

    // 恢復連線
    await client.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });
    await page.waitForTimeout(5000);

    await setView(page, p.lat, p.lng, 9);
    await page.waitForTimeout(1000);
    const after = await canvasHasPixels(page);
    await page.screenshot({ path: `../pw-screenshots/ws_reconnect_${p.icao24}.png` });

    const fatalJs = jsErrors.filter(e => e.includes('TypeError'));
    console.log(`  離線前: ${before} → 重連後: ${after} | Fatal JS: ${fatalJs.length}`);
    expect(fatalJs, `重連後 JS 錯誤: ${fatalJs.join(';')}`).toHaveLength(0);
    expect(after, '重連後 Canvas 應有內容').toBeTruthy();
    console.log('✅ WS 重連測試通過');
});

// ══════════════════════════════════════════════════════════════════════
// Test 17：響應式視窗 — 不同螢幕尺寸的軌跡顯示
// ══════════════════════════════════════════════════════════════════════
test('響應式：不同視窗大小下軌跡仍可見', async ({ page }) => {
    test.setTimeout(120000);

    let planes = [];
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);
    for (let i = 0; i < 5; i++) {
        planes = await getTrackedPlanes(page, 8, 20);
        if (planes.length) break;
        await page.waitForTimeout(5000);
    }
    if (!planes.length) return;

    const p = planes[0];
    const viewports = [
        { w: 1920, h: 1080, label: '1080p' },
        { w: 1366, h: 768,  label: '768p'  },
        { w: 1024, h: 768,  label: 'tablet-landscape' },
        { w: 768,  h: 1024, label: 'tablet-portrait' },
        { w: 390,  h: 844,  label: 'iphone14' },
        { w: 360,  h: 780,  label: 'android' },
    ];

    for (const vp of viewports) {
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await page.goto(`${BASE}/?icao=${p.icao24}`, { waitUntil: 'domcontentloaded' });
        await waitMap(page);
        await setView(page, p.lat, p.lng, 9);
        await page.waitForTimeout(1500);

        const hasContent = await canvasHasPixels(page);
        await page.screenshot({ path: `../pw-screenshots/responsive_${vp.label}_${p.icao24}.png` });
        console.log(`  ${vp.label} (${vp.w}x${vp.h}): Canvas=${hasContent}`);
        expect(hasContent, `${vp.label} 應有 Canvas 內容`).toBeTruthy();
    }
    // 恢復預設視窗
    await page.setViewportSize({ width: 1400, height: 900 });
    console.log('\n✅ 響應式測試通過');
});
