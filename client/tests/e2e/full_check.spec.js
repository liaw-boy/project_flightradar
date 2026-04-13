// @ts-check
import { test, expect } from '@playwright/test';

const BASE = 'https://flyradar.spkuan.cc';

async function goto(page, url) {
    await page.goto(url, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.leaflet-container', { timeout: 20000 });
}

test.describe('全功能檢查', () => {
    test('飛機選取與軌跡渲染', async ({ page }) => {
        test.setTimeout(150000);
        const errors = [];
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', e => errors.push('[pageerror] ' + e.message));

        // 1. 取台灣附近飛機
        const resp = await page.request.get(`${BASE}/api/flights/live`);
        const data = await resp.json();
        const tw = (data.planes || []).filter(p =>
            !p.onGround && p.lat >= 20 && p.lat <= 27 &&
            p.lon >= 118 && p.lon <= 126 && p.alt > 3000
        );
        expect(tw.length).toBeGreaterThan(0);
        const pick = tw[Math.floor(tw.length / 2)];
        const icao = pick.hex;
        console.log(`[1] 選擇 ICAO: ${icao} (${pick.callsign}) lat=${pick.lat.toFixed(2)} lon=${pick.lon.toFixed(2)}`);

        // 2. 載入含 ICAO 的 URL
        await goto(page, `${BASE}?icao=${icao}`);
        await page.waitForTimeout(10000); // 等 pan + bbox 更新 + 選取
        await page.screenshot({ path: '/tmp/c1_selected.png' });
        console.log('[2] 選取截圖完成');

        // 3. 確認 sidebar 出現（代表飛機已被選取）
        const sidebar = page.locator('[class*="sidebar"], [class*="Sidebar"]').first();
        const hasSidebar = await sidebar.isVisible().catch(() => false);
        console.log(`[3] Sidebar 可見: ${hasSidebar}`);

        // 4. 放大看軌跡
        const map = page.locator('.leaflet-container').first();
        await map.click();
        for (let i = 0; i < 4; i++) { await page.keyboard.press('+'); await page.waitForTimeout(400); }
        await page.waitForTimeout(2000);
        await page.screenshot({ path: '/tmp/c2_zoom.png' });
        console.log('[4] 放大截圖');

        for (let i = 0; i < 3; i++) { await page.keyboard.press('+'); await page.waitForTimeout(400); }
        await page.waitForTimeout(2000);
        await page.screenshot({ path: '/tmp/c3_close.png' });
        console.log('[4] 近景截圖');

        // 5. 縮小看全域
        for (let i = 0; i < 10; i++) { await page.keyboard.press('-'); await page.waitForTimeout(150); }
        await page.waitForTimeout(2000);
        await page.screenshot({ path: '/tmp/c4_global.png' });
        console.log('[5] 全域截圖');

        // 報告
        const unique = [...new Set(errors)];
        console.log(`\nConsole 錯誤: ${unique.length} 個`);
        unique.slice(0, 6).forEach(e => console.log(' -', e.slice(0, 200)));
        console.log(`Sidebar: ${hasSidebar ? '✓ 正常' : '✗ 未出現'}`);
        console.log(`spline 錯誤: ${unique.filter(e => /spline|processTrail/i.test(e)).length} 個`);

        expect(unique.filter(e => /spline|processTrail|catmull/i.test(e))).toHaveLength(0);
        await expect(map).toBeVisible();
    });
});
