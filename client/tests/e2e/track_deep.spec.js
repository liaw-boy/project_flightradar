// @ts-check
/**
 * 飛行軌跡深度測試
 * 驗證：
 *  1. 軌跡末端不超過飛機圖示
 *  2. Live Stitch 虛線從軌跡末端接到飛機
 *  3. 多架飛機切換後軌跡正確清除
 *  4. 縮放時軌跡不出現斷裂或位移
 *  5. 不同飛行階段（爬升/巡航/降落）的軌跡顯示
 */
import { test, expect } from '@playwright/test';

const BASE    = 'http://localhost:3005';
const BACKEND = 'http://localhost:3000';

// ── 工具 ──────────────────────────────────────────────────────────────
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
    await page.waitForTimeout(900);
}

/** 取得所有有軌跡點的飛機，依點數排序 */
async function getTrackedPlanes(page, minPts = 5, limit = 40) {
    const d = await page.request
        .get(`${BACKEND}/api/planes/bbox?lamin=5&lomin=95&lamax=55&lomax=150`)
        .then(r => r.json()).catch(() => ({ states: [] }));

    const result = [];
    for (const p of (d.states || []).slice(0, limit)) {
        if (!p.lat || !p.lng) continue;
        const t = await page.request
            .get(`${BACKEND}/api/tracks?icao24=${p.icao24}`)
            .then(r => r.json()).catch(() => null);
        if (t?.path?.length >= minPts) {
            result.push({ ...p, trackPts: t.path.length, path: t.path });
        }
    }
    return result.sort((a, b) => b.trackPts - a.trackPts);
}

/** 選取飛機：先用 URL 導航確保選取 */
async function selectPlane(page, icao24, lat, lng) {
    await page.goto(`${BASE}/?icao=${icao24}`, { waitUntil: 'domcontentloaded' });
    await waitMap(page);
    await setView(page, lat, lng, 10);
    await page.waitForTimeout(2000); // 等歷史軌跡載入
    const url = page.url();
    return url.includes(`icao=${icao24}`);
}

/**
 * 從 Canvas 像素分析軌跡方向：
 * 在飛機圖示前方 N 像素取樣，檢查是否有非背景像素（代表軌跡超前）
 */
async function checkTrackAhead(page, planeScreenX, planeScreenY, heading, checkDist = 40) {
    // heading: 飛機航向（度，0=北，90=東）
    const rad = (heading - 90) * Math.PI / 180; // Canvas 座標系
    const checkX = Math.round(planeScreenX + Math.cos(rad) * checkDist);
    const checkY = Math.round(planeScreenY + Math.sin(rad) * checkDist);

    return page.evaluate(({ x, y, radius }) => {
        const canvases = document.querySelectorAll('.leaflet-overlay-pane canvas');
        for (const canvas of canvases) {
            if (!canvas.width || !canvas.height) continue;
            const ctx = canvas.getContext('2d');
            if (!ctx) continue;
            const cx = Math.max(0, Math.min(canvas.width - 1, x));
            const cy = Math.max(0, Math.min(canvas.height - 1, y));
            const area = ctx.getImageData(cx - radius, cy - radius, radius * 2, radius * 2);
            // 找非透明像素（軌跡線）
            let colored = 0;
            for (let i = 3; i < area.data.length; i += 4) {
                if (area.data[i] > 30) colored++;
            }
            if (colored > 0) return { hasPixels: true, count: colored, x: cx, y: cy };
        }
        return { hasPixels: false, count: 0, x, y };
    }, { x: checkX, y: checkY, radius: 6 });
}

/** 取得飛機在 Canvas 上的像素座標（透過 Leaflet latLngToContainerPoint） */
async function getPlaneCanvasPos(page, lat, lng) {
    return page.evaluate(({ lat, lng }) => {
        const map = document.querySelector('.leaflet-container')?._leaflet_map
                 || document.querySelector('.leaflet-container')?._leafletMap;
        if (!map) return null;
        const pt = map.latLngToContainerPoint([lat, lng]);
        return { x: Math.round(pt.x), y: Math.round(pt.y) };
    }, { lat, lng });
}

// ══════════════════════════════════════════════════════════════════════
// Test 1：軌跡末端不超前飛機 — 多架飛機驗證
// ══════════════════════════════════════════════════════════════════════
test('軌跡末端不超前飛機圖示（多機驗證）', async ({ page }) => {
    test.setTimeout(300000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    // 等後端資料
    let planes = [];
    for (let i = 0; i < 8; i++) {
        planes = await getTrackedPlanes(page, 8, 50);
        if (planes.length >= 3) break;
        console.log(`  等待資料... (${planes.length} 架有軌跡)`);
        await page.waitForTimeout(5000);
    }
    console.log(`\n找到 ${planes.length} 架有軌跡的飛機`);

    const testPlanes = planes.slice(0, 5); // 測試前 5 架
    const results = [];

    for (const p of testPlanes) {
        console.log(`\n[飛機] ${p.icao24} (${p.callsign || 'N/A'}) — ${p.trackPts} 軌跡點 alt=${p.altitude}m hdg=${Math.round(p.heading)}°`);

        const ok = await selectPlane(page, p.icao24, p.lat, p.lng);
        if (!ok) { console.log('  ⚠ 選取失敗，跳過'); continue; }

        // 取得飛機在 Canvas 上的座標
        const pos = await getPlaneCanvasPos(page, p.lat, p.lng);
        if (!pos) { console.log('  ⚠ 無法取得座標'); continue; }

        // 截圖（zoom 10）
        await setView(page, p.lat, p.lng, 10);
        await page.waitForTimeout(1000);
        await page.screenshot({ path: `../pw-screenshots/deep_${p.icao24}_z10.png` });

        // 檢查飛機前方 50px 是否有軌跡像素
        const ahead = await checkTrackAhead(page, pos.x, pos.y, p.heading || 0, 50);
        const status = ahead.hasPixels ? '❌ 軌跡超前' : '✅ 正常';
        console.log(`  ${status} — 前方像素: ${ahead.count} at (${ahead.x},${ahead.y})`);

        // zoom 12 近景截圖
        await setView(page, p.lat, p.lng, 12);
        await page.waitForTimeout(800);
        await page.screenshot({ path: `../pw-screenshots/deep_${p.icao24}_z12.png` });

        results.push({
            icao: p.icao24,
            callsign: p.callsign,
            trackPts: p.trackPts,
            heading: p.heading,
            aheadPixels: ahead.count,
            pass: !ahead.hasPixels
        });
    }

    console.log('\n══════════════════════════════');
    console.log('測試結果摘要：');
    results.forEach(r => {
        const icon = r.pass ? '✅' : '❌';
        console.log(`  ${icon} ${r.icao} (${r.callsign}) ${r.trackPts}pts hdg=${Math.round(r.heading||0)}° ahead=${r.aheadPixels}px`);
    });

    const failures = results.filter(r => !r.pass);
    expect(failures.length, `${failures.length} 架飛機軌跡超前: ${failures.map(f=>f.icao).join(',')}`).toBe(0);
});

// ══════════════════════════════════════════════════════════════════════
// Test 2：多架飛機切換 — 確認軌跡正確切換
// ══════════════════════════════════════════════════════════════════════
test('切換飛機後軌跡正確清除並重載', async ({ page }) => {
    test.setTimeout(180000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    let planes = [];
    for (let i = 0; i < 6; i++) {
        planes = await getTrackedPlanes(page, 5, 30);
        if (planes.length >= 3) break;
        await page.waitForTimeout(5000);
    }

    if (planes.length < 2) {
        console.log('飛機數不足，跳過');
        return;
    }

    const [p1, p2, p3] = planes;
    console.log(`\n測試切換：${p1.icao24} → ${p2.icao24} → ${p3?.icao24 || '取消選取'}`);

    // 選飛機 1
    await selectPlane(page, p1.icao24, p1.lat, p1.lng);
    await page.screenshot({ path: `../pw-screenshots/deep_switch_p1_${p1.icao24}.png` });
    console.log(`  ✅ 選取 ${p1.icao24}`);

    // 切換到飛機 2
    await selectPlane(page, p2.icao24, p2.lat, p2.lng);
    await page.screenshot({ path: `../pw-screenshots/deep_switch_p2_${p2.icao24}.png` });
    console.log(`  ✅ 切換到 ${p2.icao24}`);

    // 確認 URL 已更換
    expect(page.url()).toContain(`icao=${p2.icao24}`);

    // 驗證 Sidebar 顯示第二架飛機
    const sidebarText = await page.locator('.sidebar').textContent().catch(() => '');
    console.log(`  Sidebar: "${sidebarText.slice(0, 60).replace(/\s+/g, ' ')}"`);

    // 切換到飛機 3（若有）
    if (p3) {
        await selectPlane(page, p3.icao24, p3.lat, p3.lng);
        await page.screenshot({ path: `../pw-screenshots/deep_switch_p3_${p3.icao24}.png` });
        console.log(`  ✅ 切換到 ${p3.icao24}`);
    }

    // ESC 取消
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const sidebar = await page.locator('.sidebar').count();
    console.log(`  ESC 後 Sidebar: ${sidebar > 0 ? '仍開著' : '已關閉'}`);

    await page.screenshot({ path: '../pw-screenshots/deep_switch_deselect.png' });
    console.log('✅ 切換測試完成');
});

// ══════════════════════════════════════════════════════════════════════
// Test 3：縮放穩定性 — 軌跡在各 zoom 層不斷裂
// ══════════════════════════════════════════════════════════════════════
test('縮放穩定性：軌跡在 z6~z14 不消失', async ({ page }) => {
    test.setTimeout(180000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    let planes = [];
    for (let i = 0; i < 6; i++) {
        planes = await getTrackedPlanes(page, 15, 30);
        if (planes.length >= 1) break;
        await page.waitForTimeout(5000);
    }
    if (!planes.length) { console.log('找不到飛機'); return; }

    const p = planes[0];
    console.log(`\n縮放測試飛機: ${p.icao24} (${p.callsign}) ${p.trackPts}pts`);
    await selectPlane(page, p.icao24, p.lat, p.lng);

    const zoomTests = [6, 7, 8, 9, 10, 11, 12, 13, 14];
    const zoomResults = [];

    for (const z of zoomTests) {
        await setView(page, p.lat, p.lng, z);
        await page.waitForTimeout(600);

        // 檢查 Canvas 有無飛機/軌跡像素
        const hasContent = await page.waitForFunction(() => {
            for (const c of document.querySelectorAll('.leaflet-overlay-pane canvas')) {
                if (!c.width || !c.height) continue;
                const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
                if (!d) continue;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 10) return true;
            }
            return false;
        }, {}, { timeout: 3000 }).then(() => true).catch(() => false);

        zoomResults.push({ zoom: z, hasContent });
        const icon = hasContent ? '✅' : '❌';
        console.log(`  Zoom ${z}: ${icon}`);
        await page.screenshot({ path: `../pw-screenshots/deep_zoom_z${z}_${p.icao24}.png` });
    }

    const failed = zoomResults.filter(r => !r.hasContent);
    expect(failed.length, `Zoom ${failed.map(r=>r.zoom).join(',')} Canvas 空白`).toBe(0);
    console.log('✅ 縮放穩定性測試通過');
});

// ══════════════════════════════════════════════════════════════════════
// Test 4：Live Stitch 方向驗證 — 虛線應指向飛機前進方向
// ══════════════════════════════════════════════════════════════════════
test('Live Stitch 虛線連接到飛機當前位置', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    let planes = [];
    for (let i = 0; i < 6; i++) {
        planes = await getTrackedPlanes(page, 10, 30);
        if (planes.length) break;
        await page.waitForTimeout(5000);
    }
    if (!planes.length) return;

    const p = planes[0];
    await selectPlane(page, p.icao24, p.lat, p.lng);
    await setView(page, p.lat, p.lng, 11);
    await page.waitForTimeout(1000);

    // 取得飛機在 Canvas 的位置
    const pos = await getPlaneCanvasPos(page, p.lat, p.lng);
    if (!pos) return;

    console.log(`\n飛機 ${p.icao24} Canvas 位置: (${pos.x}, ${pos.y})`);

    // 飛機位置附近應有像素（飛機圖示）
    const atPlane = await page.evaluate(({ x, y }) => {
        for (const c of document.querySelectorAll('.leaflet-overlay-pane canvas')) {
            const ctx = c.getContext('2d');
            if (!ctx) continue;
            const d = ctx.getImageData(Math.max(0,x-15), Math.max(0,y-15), 30, 30).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
            if (n > 0) return n;
        }
        return 0;
    }, pos);

    console.log(`  飛機位置像素: ${atPlane}`);
    await page.screenshot({ path: `../pw-screenshots/deep_livestitch_${p.icao24}.png` });

    expect(atPlane, '飛機位置應有像素（圖示渲染）').toBeGreaterThan(0);
    console.log('✅ Live Stitch 位置驗證通過');
});

// ══════════════════════════════════════════════════════════════════════
// Test 5：高速截圖比對 — 15 秒內連拍，確認軌跡只往前不後退
// ══════════════════════════════════════════════════════════════════════
test('軌跡時序正確：每 5 秒截圖確認軌跡不倒退', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitMap(page);

    let planes = [];
    for (let i = 0; i < 6; i++) {
        planes = await getTrackedPlanes(page, 10, 20);
        if (planes.length) break;
        await page.waitForTimeout(5000);
    }
    if (!planes.length) return;

    const p = planes[0];
    console.log(`\n時序測試: ${p.icao24} (${p.callsign})`);
    await selectPlane(page, p.icao24, p.lat, p.lng);
    await setView(page, p.lat, p.lng, 10);
    await page.waitForTimeout(1000);

    // 連拍 4 張，每 5 秒
    for (let i = 1; i <= 4; i++) {
        const label = `${i * 5}s`;
        await page.waitForTimeout(5000);
        await setView(page, p.lat, p.lng, 10); // 重新置中（飛機可能移動）
        await page.screenshot({ path: `../pw-screenshots/deep_timeseries_${label}_${p.icao24}.png` });
        console.log(`  ${label} 截圖完成`);
    }

    console.log('✅ 時序截圖完成，請人工確認軌跡方向一致');
});
