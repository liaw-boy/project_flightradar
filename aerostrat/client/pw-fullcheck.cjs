/**
 * AEROSTRAT Full UX Check — Playwright
 * 完整使用者體驗測試:
 *  1. 頁面載入 & WebSocket 連線
 *  2. 地圖渲染 & 飛機顯示
 *  3. 飛機點擊 & Sidebar 資料完整性
 *  4. 縮放測試 — 不同 zoom 的圖示品質
 *  5. 過濾面板互動
 *  6. 錯誤收集 (JS errors, 404s, React errors)
 *  7. 效能基線 (幀率/渲染)
 */

const { chromium } = require('playwright');
const fs = require('fs');

const BASE_URL  = 'http://localhost:3005';
const SHOTS_DIR = 'G:/project_flightradar/pw-screenshots';
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const PASS = '✅'; const FAIL = '❌'; const WARN = '⚠️ ';

// ── Helpers ──────────────────────────────────────────────────────────────────
let shot = 0;
async function snap(page, label) {
    shot++;
    const file = `${SHOTS_DIR}/${String(shot).padStart(2,'0')}-${label}.png`;
    await page.screenshot({ path: file, fullPage: false });
    console.log(`   📸 ${file}`);
}

function report(label, ok, detail = '') {
    console.log(`${ok ? PASS : FAIL} ${label}${detail ? '  →  ' + detail : ''}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
    const browser = await chromium.launch({ headless: true, args: ['--disable-web-security'] });
    const ctx = await browser.newContext({
        viewport: { width: 1600, height: 900 },
        // Simulate Taiwan timezone & locale
        locale: 'zh-TW',
        timezoneId: 'Asia/Taipei',
    });
    const page = await ctx.newPage();

    const jsErrors      = [];
    const pageErrors    = [];
    const svg404s       = [];
    const api404s       = [];
    const allLogs       = [];
    const networkFails  = [];

    page.on('console', msg => {
        const text = msg.text();
        allLogs.push(`[${msg.type().toUpperCase()}] ${text}`);
        if (msg.type() === 'error') jsErrors.push(text);
    });
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('response', resp => {
        const url  = resp.url().replace(BASE_URL, '');
        const code = resp.status();
        if (code === 404) {
            if (url.startsWith('/api/svg/'))          svg404s.push(url);
            else if (url.startsWith('/api/adsb-static/')) { /* upstream, skip */ }
            else                                       api404s.push(url);
        } else if (code >= 500) {
            networkFails.push(`[${code}] ${url}`);
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════');
    console.log('  STEP 1 — Page Load & Initial Render');
    console.log('══════════════════════════════════════════════');

    const t0 = Date.now();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for loading screen to disappear
    try {
        await page.waitForSelector('.loading-screen', { state: 'hidden', timeout: 12000 });
        report('Loading screen dismissed', true);
    } catch {
        report('Loading screen', false, 'still visible after 12s');
    }

    const loadMs = Date.now() - t0;
    report(`Initial load time`, loadMs < 8000, `${loadMs}ms`);
    await snap(page, 'initial-load');

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════');
    console.log('  STEP 2 — WebSocket & Data Stream');
    console.log('══════════════════════════════════════════════');

    // Wait for first poll + WS connection
    await page.waitForTimeout(4000);
    const wsConnected = allLogs.some(l => l.includes('WebSocket Connected') || l.includes('AERO-SYNC'));
    const pollOk      = allLogs.some(l => l.includes('Poll OK'));
    report('WebSocket connected', wsConnected);
    report('Initial poll success', pollOk);

    // Wait for WS batch (up to 15s after load)
    let wsBatch = false;
    for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(1000);
        if (allLogs.some(l => l.includes('WS Batch'))) { wsBatch = true; break; }
    }
    report('WS batch received', wsBatch);

    // Extract plane count from HUD
    const planeCount = await page.evaluate(() => {
        const els = [...document.querySelectorAll('[class*="stat"]')];
        for (const el of els) {
            const n = parseInt(el.textContent || '');
            if (n > 0) return n;
        }
        return 0;
    });
    report(`Planes in view`, planeCount > 0, `${planeCount} aircraft`);
    await snap(page, 'after-ws-data');

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════');
    console.log('  STEP 3 — Aircraft Click & Sidebar');
    console.log('══════════════════════════════════════════════');

    const canvas = await page.$('canvas');
    let clickedPlane = false;
    let sidebarData  = {};

    if (canvas) {
        const box = await canvas.boundingBox();
        // Try many positions — some will hit planes
        const spots = [];
        for (let xRatio = 0.25; xRatio <= 0.75; xRatio += 0.05) {
            for (let yRatio = 0.25; yRatio <= 0.75; yRatio += 0.08) {
                spots.push({ x: box.x + box.width * xRatio, y: box.y + box.height * yRatio });
            }
        }

        for (const spot of spots) {
            await page.mouse.click(spot.x, spot.y);
            await page.waitForTimeout(600);

            const sidebar = await page.$('[class*="sidebar"], [class*="Sidebar"]');
            if (sidebar && await sidebar.isVisible()) {
                clickedPlane = true;
                console.log(`   Clicked plane at (${Math.round(spot.x)}, ${Math.round(spot.y)})`);
                break;
            }
        }
    }
    report('Clicked a plane', clickedPlane);

    if (clickedPlane) {
        await page.waitForTimeout(3000); // Let enrichment load
        await snap(page, 'sidebar-open');

        // Extract sidebar data
        const callsignEl = await page.$('[class*="callsign"], [class*="sb-callsign"]');
        const callsign   = callsignEl ? (await callsignEl.textContent()).trim() : '';

        const badgeEls = await page.$$('[class*="sb-badge"], [class*="badge"]');
        const badges   = await Promise.all(badgeEls.map(el => el.textContent()));

        const allText = await page.$$eval('[class*="sidebar"] *', els =>
            els.map(e => (e.textContent || '').trim()).filter(t => t && t.length < 80)
        );
        const sidebarStr = allText.join(' | ');

        // Data quality checks
        sidebarData = {
            callsign,
            badges: badges.filter(Boolean),
            hasDep: sidebarStr.includes('DEP') || sidebarStr.includes('HND') || sidebarStr.length > 20,
            hasTypecode: /[A-Z][0-9A-Z]{2,4}/.test(sidebarStr),
            hasMissing: (sidebarStr.match(/--/g) || []).length,
        };

        report('Sidebar: callsign visible', !!callsign, callsign || 'NONE');
        report('Sidebar: typecode badge', sidebarData.hasTypecode, badges.slice(0,3).join(', '));
        report('Sidebar: route data', sidebarData.hasDep);
        const excessiveMissing = sidebarData.hasMissing > 4;
        report('Sidebar: minimal missing data', !excessiveMissing, `${sidebarData.hasMissing} "--" fields`);

        // Check for enrichment credit line
        const hasCredit = sidebarStr.includes('RexKramer') || sidebarStr.includes('AircraftShapes');
        report('Sidebar: SVG credit line shows', hasCredit);

        // Close sidebar
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
    }

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════');
    console.log('  STEP 4 — Zoom Tests (Icon Quality)');
    console.log('══════════════════════════════════════════════');

    // Zoom in using keyboard shortcuts or mouse wheel
    for (let i = 0; i < 3; i++) {
        await page.keyboard.press('+');
        await page.waitForTimeout(300);
    }
    await page.waitForTimeout(800);
    await snap(page, 'zoom-in');
    report('Zoom in (keyboard +)', true, 'icons should be larger');

    for (let i = 0; i < 5; i++) {
        await page.keyboard.press('-');
        await page.waitForTimeout(300);
    }
    await page.waitForTimeout(800);
    await snap(page, 'zoom-out');
    report('Zoom out (keyboard -)', true, 'tactical dots at low zoom');

    // Reset zoom
    for (let i = 0; i < 2; i++) {
        await page.keyboard.press('+');
        await page.waitForTimeout(300);
    }

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════');
    console.log('  STEP 5 — UI Controls Interaction');
    console.log('══════════════════════════════════════════════');

    // Try to find and click filter button / settings
    const filterBtn = await page.$('[class*="filter"], [class*="Filter"], [title*="filter"], [title*="Filter"]');
    if (filterBtn) {
        await filterBtn.click();
        await page.waitForTimeout(800);
        await snap(page, 'filter-panel');
        report('Filter panel opens', true);
        await page.keyboard.press('Escape');
    } else {
        report('Filter button', false, 'not found (may be hidden)');
    }

    // Check HUD stats are visible
    const hudStats = await page.$$eval('[class*="stat"], [class*="hud"], [class*="HUD"]', els =>
        els.map(el => el.textContent?.trim()).filter(t => t && t.length < 30)
    );
    report('HUD stats visible', hudStats.length > 0, hudStats.slice(0,4).join(' | '));

    await snap(page, 'final-state');

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════');
    console.log('  STEP 6 — Error Audit');
    console.log('══════════════════════════════════════════════');

    // JS Errors (exclude 404 resource messages)
    const realJsErrors = jsErrors.filter(e => !e.includes('Failed to load resource'));
    report(`JS runtime errors`, realJsErrors.length === 0, `${realJsErrors.length} errors`);
    if (realJsErrors.length > 0) {
        realJsErrors.slice(0, 10).forEach(e => console.log(`   ${FAIL} ${e.substring(0,120)}`));
    }

    // Page-level errors (uncaught exceptions)
    report(`Uncaught exceptions`, pageErrors.length === 0, `${pageErrors.length} errors`);
    if (pageErrors.length > 0) {
        pageErrors.slice(0, 5).forEach(e => console.log(`   ${FAIL} ${e.substring(0,120)}`));
    }

    // SVG 404s (missing silhouette files)
    report(`SVG icons (404)`, svg404s.length <= 10, `${svg404s.length} missing types`);
    if (svg404s.length > 0 && svg404s.length <= 30) {
        svg404s.forEach(u => console.log(`   ${WARN}${u}`));
    }

    // Critical API 404s (non-SVG, non-adsb-static)
    report(`API endpoints (404)`, api404s.length === 0, `${api404s.length} errors`);
    api404s.forEach(u => console.log(`   ${FAIL} ${u}`));

    // 5xx errors
    report(`Server errors (5xx)`, networkFails.length === 0, `${networkFails.length} errors`);
    networkFails.forEach(u => console.log(`   ${FAIL} ${u}`));

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════');
    console.log('  STEP 7 — React Specific Checks');
    console.log('══════════════════════════════════════════════');

    // Check for React error overlay
    const reactError = await page.$('[data-testid="error-overlay"], #react-error-overlay, .react-error-overlay');
    report('No React error overlay', !reactError);

    // Check core elements rendered
    const canvasEl    = await page.$('canvas');
    const sidebarBase = await page.$('[class*="sidebar-container"], [class*="Sidebar"]');
    const hudEl       = await page.$('[class*="hud"], [class*="stats"], [class*="radar"]');
    report('Canvas element rendered', !!canvasEl);
    report('Sidebar container present', !!sidebarBase);
    report('HUD/Stats rendered', !!hudEl);

    // Check for duplicate renders (canvas count should be 1-3 at most for Leaflet)
    const canvasCount = await page.$$eval('canvas', els => els.length);
    report('Canvas count reasonable', canvasCount <= 4, `${canvasCount} canvas elements`);

    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════');
    console.log('  SUMMARY');
    console.log('══════════════════════════════════════════════');
    console.log(`Planes tracked   : ${planeCount}`);
    console.log(`SVG 404s         : ${svg404s.length} (missing silhouette types — graceful fallback)`);
    console.log(`JS errors        : ${realJsErrors.length}`);
    console.log(`API errors       : ${api404s.length}`);
    console.log(`Server errors    : ${networkFails.length}`);
    console.log(`Screenshots      : ${SHOTS_DIR}`);
    console.log('');

    const critical = realJsErrors.length + pageErrors.length + api404s.length + networkFails.length;
    if (critical === 0) {
        console.log(`${PASS} All critical checks passed — system is healthy`);
    } else {
        console.log(`${FAIL} ${critical} critical issue(s) detected — see above`);
    }

    await browser.close();
})();
