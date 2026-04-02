// @ts-check
import { test } from '@playwright/test';

const BASE    = 'http://localhost:3005';
const BACKEND = 'http://localhost:3000';

/** 以飛機位置為中心飛到指定 zoom（保持 URL 中的 icao= 不變）*/
async function zoomToPlane(page, lat, lng, zoom) {
    await page.evaluate(({ lat, lng, zoom }) => {
        const c = document.querySelector('.leaflet-container');
        const map = c?._leaflet_map || c?._leafletMap;
        if (map) map.setView([lat, lng], zoom, { animate: false });
    }, { lat, lng, zoom });
    await page.waitForTimeout(800);
}

test('軌跡接縫近距離截圖（無短尾）', async ({ page }) => {
    test.setTimeout(180000);

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.locator('.leaflet-container').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(2000);

    // 找軌跡點最多的飛機
    let best = null;
    for (let i = 0; i < 6; i++) {
        const d = await page.request
            .get(`${BACKEND}/api/planes/bbox?lamin=10&lomin=100&lamax=50&lomax=145`)
            .then(r => r.json()).catch(() => null);
        if (!d?.states?.length) { await page.waitForTimeout(5000); continue; }

        const candidates = d.states.slice(0, 30).filter(p => p.lat && p.lng);
        for (const p of candidates) {
            const t = await page.request
                .get(`${BACKEND}/api/tracks?icao24=${p.icao24}`)
                .then(r => r.json()).catch(() => null);
            if (t?.path?.length > 20) {
                best = { ...p, pts: t.path.length };
                break;
            }
        }
        if (best) break;
        await page.waitForTimeout(5000);
    }

    if (!best) { console.log('找不到足夠軌跡點的飛機'); return; }
    console.log(`目標飛機: ${best.icao24} (${best.callsign}) — ${best.pts} 軌跡點`);
    console.log(`位置: ${best.lat?.toFixed(4)}, ${best.lng?.toFixed(4)}`);

    // 飛到飛機位置 zoom 8
    await zoomToPlane(page, best.lat, best.lng, 8);

    // 點擊飛機附近，選取
    const mapBox = await page.locator('.leaflet-container').boundingBox();
    const cx = mapBox.x + mapBox.width / 2;
    const cy = mapBox.y + mapBox.height / 2;

    let selected = false;
    const clicks = [[0,0],[0.03,-0.03],[-0.03,0.03],[0.05,0],[0,-0.05],[-0.05,0],[0,0.05],
                    [0.08,-0.08],[-0.08,0.08],[0.1,0],[-0.1,0],[0,0.1],[0,-0.1]];
    for (const [dx, dy] of clicks) {
        await page.mouse.click(cx + dx * mapBox.width, cy + dy * mapBox.height);
        await page.waitForTimeout(600);
        if (page.url().includes('icao=')) { selected = true; break; }
    }

    if (!selected) {
        console.log('未能選中飛機，直接用 URL 導航');
        await page.goto(`${BASE}/?icao=${best.icao24}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        await zoomToPlane(page, best.lat, best.lng, 8);
    }

    const icao = page.url().includes('icao=')
        ? new URL(page.url()).searchParams.get('icao')
        : best.icao24;
    console.log(`選中: ${icao}`);

    // 等歷史軌跡載入
    await page.waitForTimeout(3000);

    // 各 zoom 截圖，保持飛機置中
    for (const zoom of [8, 9, 10, 11, 12, 13]) {
        await zoomToPlane(page, best.lat, best.lng, zoom);
        await page.screenshot({ path: `../pw-screenshots/notail_z${zoom}_${icao}.png` });
        console.log(`  zoom ${zoom} → notail_z${zoom}_${icao}.png`);
    }

    // 等 20 秒，觀察 Live Stitch 虛線是否正確延伸
    console.log('\n等待 20 秒觀察 Live Stitch...');
    await zoomToPlane(page, best.lat, best.lng, 11);
    await page.waitForTimeout(10000);
    await page.screenshot({ path: `../pw-screenshots/notail_z11_10s_${icao}.png` });
    await page.waitForTimeout(10000);
    await page.screenshot({ path: `../pw-screenshots/notail_z11_20s_${icao}.png` });

    console.log(`\n✅ 完成 — 截圖: pw-screenshots/notail_*.png`);
});
