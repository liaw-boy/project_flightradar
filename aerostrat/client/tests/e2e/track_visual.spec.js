// @ts-check
/**
 * 飛行軌跡視覺驗證測試
 * 選取飛機、等待歷史軌跡載入、在不同縮放下截圖觀察軌跡顯示
 */
import { test, expect } from '@playwright/test';

const BASE    = 'http://localhost:3005';
const BACKEND = 'http://localhost:3000';

async function waitForMap(page) {
    await page.locator('.leaflet-container').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(1500);
}

async function flyTo(page, lat, lng, zoom) {
    await page.evaluate(({ lat, lng, zoom }) => {
        const c = document.querySelector('.leaflet-container');
        const map = c?._leaflet_map || c?._leafletMap;
        if (map) map.setView([lat, lng], zoom);
    }, { lat, lng, zoom });
    await page.waitForTimeout(1200);
}

async function clickUntilSelected(page, attempts = 20) {
    const map  = page.locator('.leaflet-container');
    const box  = await map.boundingBox();
    const pts  = [
        [0.50, 0.50],[0.40, 0.45],[0.60, 0.45],[0.45, 0.60],[0.55, 0.35],
        [0.30, 0.50],[0.70, 0.50],[0.50, 0.30],[0.50, 0.70],[0.35, 0.35],
        [0.65, 0.65],[0.25, 0.40],[0.75, 0.40],[0.40, 0.25],[0.60, 0.75],
        [0.20, 0.55],[0.80, 0.55],[0.55, 0.20],[0.45, 0.80],[0.33, 0.66],
    ];
    for (let i = 0; i < Math.min(attempts, pts.length); i++) {
        await page.mouse.click(box.x + box.width * pts[i][0], box.y + box.height * pts[i][1]);
        await page.waitForTimeout(700);
        if (page.url().includes('icao=')) {
            return new URL(page.url()).searchParams.get('icao');
        }
    }
    return null;
}

// ══════════════════════════════════════════════════════
test('飛行軌跡視覺檢查', async ({ page }) => {
    test.setTimeout(180000);

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitForMap(page);

    // 等後端有足夠飛機
    for (let i = 0; i < 6; i++) {
        const d = await page.request
            .get(`${BACKEND}/api/planes/bbox?lamin=10&lomin=100&lamax=50&lomax=145`)
            .then(r => r.json()).catch(() => null);
        if (d?.states?.length > 10) { console.log(`  後端: ${d.states.length} 架`); break; }
        await page.waitForTimeout(5000);
    }

    // ── Step 1: 選取一架飛機 ──────────────────────────
    console.log('\n[Step 1] 嘗試選取飛機...');
    await flyTo(page, 25.0, 121.5, 8);
    const icao = await clickUntilSelected(page, 20);

    if (!icao) {
        console.log('  未選中飛機，截圖當前狀態');
        await page.screenshot({ path: '../pw-screenshots/track_no_selection.png', fullPage: false });
        return;
    }
    console.log(`  選中: ${icao}`);
    await page.screenshot({ path: `../pw-screenshots/track_selected_${icao}.png` });

    // ── Step 2: 等待歷史軌跡從後端載入 ───────────────
    console.log('\n[Step 2] 等待歷史軌跡載入...');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `../pw-screenshots/track_after_3s_${icao}.png` });

    // ── Step 3: 縮放到不同層級，觀察軌跡 ──────────────
    const zoomLevels = [10, 8, 6, 12];
    for (const z of zoomLevels) {
        console.log(`\n[Step 3] Zoom ${z}...`);
        for (let i = 0; i < (z > 8 ? 3 : 3); i++) {
            const delta = z > 8 ? -200 : 200;
            await page.mouse.wheel(0, delta);
            await page.waitForTimeout(200);
        }
        await page.waitForTimeout(1000);
        await page.screenshot({ path: `../pw-screenshots/track_zoom${z}_${icao}.png` });
        console.log(`  截圖: track_zoom${z}_${icao}.png`);
    }

    // ── Step 4: 拍攝等待 10 秒後短尾是否跟上歷史軌跡 ──
    console.log('\n[Step 4] 觀察 10 秒後短尾連接狀況...');
    await flyTo(page, 25.0, 121.5, 8);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `../pw-screenshots/track_10s_before_${icao}.png` });
    await page.waitForTimeout(10000);
    await page.screenshot({ path: `../pw-screenshots/track_10s_after_${icao}.png` });
    console.log('  截圖: track_10s_before / after');

    // ── Step 5: 移動到高密度區域截圖 ──────────────────
    console.log('\n[Step 5] 移動到高密度航班區域觀察多機軌跡...');

    // 台北上空 zoom 9
    await flyTo(page, 25.08, 121.55, 9);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `../pw-screenshots/track_taipei_z9_${icao}.png` });

    // zoom 7 看更廣範圍
    await flyTo(page, 24.0, 121.0, 7);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `../pw-screenshots/track_taiwan_z7_${icao}.png` });

    // ── Step 6: 驗證後端實際回傳幾個點 ──────────────────
    console.log('\n[Step 6] 查詢後端軌跡資料...');
    const trackResp = await page.request
        .get(`${BACKEND}/api/tracks?icao24=${icao}`)
        .then(r => r.json()).catch(() => null);

    if (trackResp?.path) {
        console.log(`  後端軌跡點數: ${trackResp.path.length}`);
        if (trackResp.path.length > 0) {
            const first = trackResp.path[0];
            const last  = trackResp.path[trackResp.path.length - 1];
            const spanMin = last[0] && first[0] ? ((last[0] - first[0]) / 60).toFixed(1) : '?';
            console.log(`  時間跨度: ${spanMin} 分鐘`);
            console.log(`  首點: [${first[1]?.toFixed(4)}, ${first[2]?.toFixed(4)}] alt=${first[3]}m`);
            console.log(`  末點: [${last[1]?.toFixed(4)}, ${last[2]?.toFixed(4)}] alt=${last[3]}m`);
        }
    }

    // 最終截圖
    await page.screenshot({ path: `../pw-screenshots/track_final_${icao}.png` });
    console.log('\n✅ 軌跡視覺測試完成');
    console.log(`  截圖位置: pw-screenshots/track_*.png`);
});
