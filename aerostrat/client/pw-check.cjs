/**
 * AEROSTRAT Frontend Live Check — Playwright
 * 1. 載入首頁，等待地圖渲染
 * 2. 擷取 console errors / warnings
 * 3. 等待飛機出現 (WS delta 或 polling)
 * 4. 點選第一架飛機，等待 Sidebar 顯示
 * 5. 驗證 typecode、registration、route 欄位
 * 6. 截圖
 */

const { chromium } = require('playwright');
const fs = require('fs');

const BASE_URL = 'http://localhost:3005';
const SCREENSHOT_DIR = 'G:/project_flightradar/pw-screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await ctx.newPage();

    const consoleLogs = [];
    const consoleErrors = [];
    const failed404s = [];

    page.on('console', msg => {
        const text = msg.text();
        const entry = `[${msg.type().toUpperCase()}] ${text}`;
        consoleLogs.push(entry);
        if (msg.type() === 'error') consoleErrors.push(text);
    });
    page.on('pageerror', err => {
        consoleErrors.push(`[PAGE ERROR] ${err.message}`);
    });
    // Capture actual 404 request URLs
    page.on('response', resp => {
        if (resp.status() === 404) {
            failed404s.push(resp.url().replace(BASE_URL, ''));
        }
    });

    console.log('\n=== STEP 1: Load page ===');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000); // let React hydrate
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-initial-load.png` });
    console.log('✅ Page loaded');

    console.log('\n=== STEP 2: Wait for loading screen to disappear ===');
    try {
        await page.waitForSelector('.loading-screen', { state: 'hidden', timeout: 10000 });
        console.log('✅ Loading screen gone');
    } catch {
        console.log('ℹ️  No loading screen found (or already gone)');
    }
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-after-loading.png` });

    console.log('\n=== STEP 3: Wait for aircraft to appear on map (max 20s) ===');
    // Wait for canvas to have content OR for plane count indicator to show > 0
    let planeCount = 0;
    try {
        await page.waitForFunction(() => {
            const el = document.querySelector('[class*="stat-value"], .plane-count, .hud-count');
            if (el && parseInt(el.textContent) > 0) return true;
            // Also check if canvas exists
            const canvas = document.querySelector('canvas');
            return canvas != null;
        }, { timeout: 20000 });

        // Try to read plane count from dashboard
        const countText = await page.$$eval('[class*="stat"]', els => {
            for (const el of els) {
                const n = parseInt(el.textContent);
                if (n > 0) return el.textContent.trim();
            }
            return '?';
        });
        console.log(`✅ Canvas rendered. Dashboard stat: ${countText}`);
    } catch {
        console.log('⚠️  Canvas or plane count not found within 20s');
    }
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-map-rendered.png` });

    // Wait a bit more for WS batches to arrive
    console.log('\n=== STEP 4: Wait 6s for WS plane data ===');
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-after-ws-wait.png` });

    // Check console logs for WS connection
    const wsConnected = consoleLogs.some(l => l.includes('WebSocket Connected') || l.includes('AERO-SYNC'));
    const wsBatches = consoleLogs.filter(l => l.includes('WS Batch'));
    const pollOk = consoleLogs.some(l => l.includes('Poll OK'));
    console.log(`  WS Connected: ${wsConnected}`);
    console.log(`  WS Batches: ${wsBatches.length}`);
    console.log(`  Poll OK: ${pollOk}`);

    console.log('\n=== STEP 5: Try clicking a plane ===');
    // Try clicking the canvas in the center-ish area where planes are likely to be
    const canvas = await page.$('canvas');
    let clickedPlane = false;
    if (canvas) {
        const box = await canvas.boundingBox();
        // Try several spots
        const spots = [
            { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 },
            { x: box.x + box.width * 0.4, y: box.y + box.height * 0.4 },
            { x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 },
            { x: box.x + box.width * 0.35, y: box.y + box.height * 0.55 },
            { x: box.x + box.width * 0.65, y: box.y + box.height * 0.45 },
        ];

        for (const spot of spots) {
            await page.mouse.click(spot.x, spot.y);
            await page.waitForTimeout(1500);

            // Check if sidebar appeared
            const sidebar = await page.$('[class*="sidebar"], [class*="Sidebar"], #sidebar');
            const sidebarVisible = sidebar && await sidebar.isVisible();
            if (sidebarVisible) {
                clickedPlane = true;
                console.log(`✅ Plane clicked at (${Math.round(spot.x)}, ${Math.round(spot.y)}), Sidebar opened`);
                break;
            }
        }
        if (!clickedPlane) {
            console.log('⚠️  Could not click a plane (map may have no planes in view, or click missed)');
        }
    }
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-after-click.png` });

    if (clickedPlane) {
        console.log('\n=== STEP 6: Check Sidebar content ===');
        // Wait for fusion data to load (complete-details API)
        await page.waitForTimeout(3000);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/06-sidebar-loaded.png` });

        // Extract key fields from sidebar
        const sidebarText = await page.$$eval('[class*="sidebar"] *', els =>
            els.map(el => ({ tag: el.tagName, text: el.textContent?.trim().substring(0, 80) }))
               .filter(e => e.text && e.text.length > 0)
        );

        // Look for specific data indicators
        const callsignEl = await page.$('[class*="callsign"], [class*="sb-callsign"]');
        const callsignText = callsignEl ? await callsignEl.textContent() : 'NOT FOUND';

        const badgeEls = await page.$$('[class*="sb-badge"], [class*="badge"]');
        const badges = await Promise.all(badgeEls.map(el => el.textContent()));

        // Find registration and typecode
        const allText = sidebarText.map(e => e.text).join(' | ');

        console.log(`  Callsign: ${callsignText}`);
        console.log(`  Badges: ${badges.join(', ')}`);

        // Check for broken indicators
        const hasDashDash = allText.includes('--');
        const hasUnknown = allText.toLowerCase().includes('unknown aircraft') || allText.toLowerCase().includes('n/a');
        const hasTypecodePattern = /[A-Z][0-9A-Z]{2,4}/.test(allText); // B788, A320, etc.

        console.log(`  Has "--" (missing data): ${hasDashDash}`);
        console.log(`  Has "unknown"/"n/a": ${hasUnknown}`);
        console.log(`  Has typecode pattern: ${hasTypecodePattern}`);

        // Print relevant sidebar rows
        const rows = sidebarText.filter(e => e.text.length > 1 && e.text.length < 50);
        console.log('\n  Sidebar data rows:');
        rows.slice(0, 25).forEach(r => console.log(`    ${r.text}`));
    }

    console.log('\n=== STEP 7: 404 URLs ===');
    const unique404s = [...new Set(failed404s)];
    if (unique404s.length === 0) {
        console.log('✅ No 404 errors');
    } else {
        console.log(`❌ ${unique404s.length} unique 404 URLs:`);
        unique404s.slice(0, 30).forEach(u => console.log(`  - ${u}`));
    }

    console.log('\n=== STEP 8: Console Errors (non-404) ===');
    const nonResourceErrors = consoleErrors.filter(e => !e.includes('Failed to load resource'));
    if (nonResourceErrors.length === 0) {
        console.log('✅ No JS errors');
    } else {
        console.log(`❌ ${nonResourceErrors.length} JS errors:`);
        nonResourceErrors.slice(0, 20).forEach(e => console.log(`  - ${e}`));
    }

    console.log('\n=== STEP 8: Notable console logs ===');
    const notable = consoleLogs.filter(l =>
        l.includes('ERROR') || l.includes('WARN') || l.includes('WS') ||
        l.includes('FETCH') || l.includes('INIT') || l.includes('Poll')
    ).slice(0, 30);
    notable.forEach(l => console.log(`  ${l}`));

    console.log('\n=== Screenshots saved to:', SCREENSHOT_DIR, '===');
    await browser.close();
})();
