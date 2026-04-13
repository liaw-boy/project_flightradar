// @ts-check
import { test, expect } from '@playwright/test';

const BASE = 'https://flyradar.spkuan.cc';

async function gotoAndWait(page, url) {
    await page.goto(url, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.leaflet-container', { timeout: 25000 });
}

test.describe('trailSpline pipeline 驗證（正式版）', () => {
    test('軌跡渲染截圖與錯誤偵測', async ({ page }) => {
        test.setTimeout(120000);

        const consoleErrors = [];
        const splineErrors  = [];
        page.on('console', msg => {
            const text = msg.text();
            if (msg.type() === 'error') {
                consoleErrors.push(text);
                if (/spline|trail|processTrail|catmull/i.test(text)) splineErrors.push(text);
            }
        });
        page.on('pageerror', e => consoleErrors.push('[pageerror] ' + e.message));

        // ── Step 1: 首頁 ──────────────────────────────────────────────────
        console.log('[1] 載入首頁...');
        await gotoAndWait(page, BASE);
        await page.waitForTimeout(5000);
        await page.screenshot({ path: '/tmp/ts_1_overview.png' });
        console.log('[1] 完成');

        // ── Step 2: 取飛機 ICAO（用正確的 API 端點） ─────────────────────
        const icao = await page.evaluate(async (base) => {
            try {
                const r = await fetch(`${base}/api/flights/live`);
                const d = await r.json();
                const arr = d.planes || [];
                // 找台灣附近 (lat 20-27, lon 118-125)、高空、有軌跡的飛機
                const nearby = arr.filter(p =>
                    !p.onGround && p.lat >= 20 && p.lat <= 27 &&
                    p.lon >= 118 && p.lon <= 125 && p.alt > 3000
                );
                if (nearby.length > 0) return nearby[0].hex;
                // 備援：取高空飛機
                const airborne = arr.filter(p => !p.onGround && p.alt > 8000);
                airborne.sort((a, b) => b.alt - a.alt);
                return airborne[0]?.hex || null;
            } catch (e) { return null; }
        }, BASE);

        console.log(`[2] 選擇 ICAO: ${icao}`);
        expect(icao).toBeTruthy();

        // ── Step 3: 選取飛機 ──────────────────────────────────────────────
        console.log('[3] 載入飛機頁面...');
        await gotoAndWait(page, `${BASE}?icao=${icao}`);
        await page.waitForTimeout(7000);
        await page.screenshot({ path: '/tmp/ts_2_selected.png' });
        console.log('[3] 完成');

        // ── Step 4: 軌跡截圖 ──────────────────────────────────────────────
        await page.waitForTimeout(3000);
        await page.screenshot({ path: '/tmp/ts_3_trail.png' });
        console.log('[4] 軌跡截圖完成');

        // ── Step 5: 放大看細節 ────────────────────────────────────────────
        const map = page.locator('.leaflet-container').first();
        await map.click();
        for (let i = 0; i < 4; i++) { await page.keyboard.press('+'); await page.waitForTimeout(400); }
        await page.waitForTimeout(1500);
        await page.screenshot({ path: '/tmp/ts_4_zoom.png' });
        console.log('[5] 放大截圖完成');

        for (let i = 0; i < 3; i++) { await page.keyboard.press('+'); await page.waitForTimeout(400); }
        await page.waitForTimeout(1500);
        await page.screenshot({ path: '/tmp/ts_5_closeup.png' });
        console.log('[5] 近景截圖完成');

        // ── Step 6: 報告 ──────────────────────────────────────────────────
        console.log('\n=== 測試報告 ===');
        console.log(`Console 錯誤: ${consoleErrors.length} 個`);
        if (consoleErrors.length) {
            [...new Set(consoleErrors)].slice(0, 8).forEach(e =>
                console.log(' -', e.slice(0, 200)));
        }
        if (splineErrors.length) {
            console.log(`\n[FAIL] trailSpline 錯誤 ${splineErrors.length} 個:`);
            splineErrors.forEach(e => console.log(' -', e));
        } else {
            console.log('\n[OK] trailSpline 無錯誤 ✓');
        }
        console.log('截圖: /tmp/ts_1~5_*.png');
        console.log('=== END ===');

        expect(splineErrors).toHaveLength(0);
        await expect(map).toBeVisible();
    });
});
