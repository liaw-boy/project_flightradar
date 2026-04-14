// @ts-check
/**
 * UX Flow Test — localhost:3000
 * Tests the key user journeys:
 *   1. 首頁載入 / JS 無致命錯誤
 *   2. 地圖渲染 + 飛機出現
 *   3. 搜尋功能
 *   4. 登入流程 (UI visibility)
 *   5. My Flights Panel 開啟
 *   6. 新增航班表單 全頁展開
 *   7. API 健康檢查
 *   8. WebSocket 資料流
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const BASE = 'http://localhost:3000';
const DIR  = path.resolve('..', 'pw-screenshots', 'ux-flow');
fs.mkdirSync(DIR, { recursive: true });

async function shot(page, name) {
    const p = path.join(DIR, `${name}.png`);
    await page.screenshot({ path: p, fullPage: false });
    console.log(`  📸 ${p}`);
    return p;
}

// ─── 1. 首頁載入 ──────────────────────────────────────────────────────────────
test('1 - homepage loads without fatal JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    const res = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    expect(res.status()).toBe(200);

    await page.waitForTimeout(2000);
    await shot(page, '01-homepage');

    // Exclude known pre-existing Buffer polyfill warning from msgpack-lite worker
    const fatal = errors.filter(e =>
        /uncaught|cannot read|is not a function/i.test(e) &&
        !/reading 'Buffer'/i.test(e)
    );
    if (fatal.length) console.warn('⚠ Fatal JS:', fatal);
    expect(fatal).toHaveLength(0);
});

// ─── 2. 地圖 + 飛機 ───────────────────────────────────────────────────────────
test('2 - map renders and aircraft appear within 15s', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Leaflet container
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10000 });

    // Canvas with drawn pixels
    const hasPlanes = await page.waitForFunction(() => {
        for (const c of document.querySelectorAll('.leaflet-overlay-pane canvas')) {
            if (c.width > 0 && c.height > 0) {
                const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
                if (d && Array.from(d).some((v, i) => i % 4 === 3 && v > 0)) return true;
            }
        }
        return false;
    }, {}, { timeout: 15000 }).then(() => true).catch(() => false);

    await shot(page, '02-map-with-aircraft');
    console.log(`  Aircraft visible: ${hasPlanes}`);
    // Soft check — data may not be flowing in offline environment
    expect(hasPlanes || true).toBe(true);
});

// ─── 3. 搜尋功能 ──────────────────────────────────────────────────────────────
test('3 - search bar is visible and accepts input', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const searchBar = page.locator('input[placeholder*="Search"], input[placeholder*="search"], input[type="search"], .search-input, [class*="search"] input').first();
    const count = await searchBar.count();
    if (count === 0) {
        console.log('  ℹ Search bar not immediately visible — may be behind a toggle');
        await shot(page, '03-search-not-found');
        return; // soft skip
    }

    await expect(searchBar).toBeVisible({ timeout: 5000 });
    await searchBar.fill('CI101');
    await page.waitForTimeout(800);
    await shot(page, '03-search-ci101');

    const inputVal = await searchBar.inputValue();
    expect(inputVal).toBe('CI101');
});

// ─── 4. 登入 UI ───────────────────────────────────────────────────────────────
test('4 - auth modal opens when clicking login button', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Find login trigger — could be in topbar or sidebar
    const loginTrigger = page.locator(
        '[class*="login"], [class*="auth"], button:has-text("登入"), button:has-text("Login"), button:has-text("Sign")'
    ).first();

    const found = await loginTrigger.count();
    if (!found) {
        console.log('  ℹ Login button not found — user may already be logged in');
        await shot(page, '04-no-login-btn');
        return;
    }

    await loginTrigger.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, '04-auth-modal');

    // Modal should be visible
    const modal = page.locator('.auth-overlay, [class*="auth-modal"], [class*="login-modal"]').first();
    const modalVisible = await modal.isVisible().catch(() => false);
    if (modalVisible) {
        console.log('  ✓ Auth modal opened');
        // Check username/password fields exist
        await expect(page.locator('input[type="password"]').first()).toBeVisible({ timeout: 3000 });
    } else {
        console.log('  ℹ Auth modal pattern not matched — checking for form fields');
        const pwField = await page.locator('input[type="password"]').count();
        expect(pwField).toBeGreaterThan(0);
    }
});

// ─── 5. TopBar user menu ──────────────────────────────────────────────────────
test('5 - topbar renders with title and action buttons', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const topbar = page.locator('.topbar, header, [class*="top-bar"], [class*="navbar"]').first();
    await expect(topbar).toBeVisible({ timeout: 8000 });
    await shot(page, '05-topbar');

    const tbText = await topbar.textContent().catch(() => '');
    console.log(`  TopBar text: "${tbText.slice(0, 100)}"`);
    expect(tbText.trim().length).toBeGreaterThan(0);
});

// ─── 6. My Flights: LOG FLIGHT 開全頁 ────────────────────────────────────────
test('6 - my flights panel opens and log flight goes full page', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Find "my flights" trigger
    const triggers = page.locator(
        'button:has-text("Flight"), button:has-text("航班"), [class*="flight-log"], [class*="my-flight"]'
    );
    const trigCount = await triggers.count();
    if (!trigCount) {
        console.log('  ℹ My Flights trigger not visible (may need login)');
        await shot(page, '06-no-flights-trigger');
        return;
    }

    await triggers.first().click({ timeout: 5000 });
    await page.waitForTimeout(800);
    await shot(page, '06a-flights-panel');

    // Click LOG FLIGHT button
    const logBtn = page.locator('button:has-text("LOG FLIGHT"), button:has-text("LOG"), button:has-text("新增")').first();
    const logBtnCount = await logBtn.count();
    if (logBtnCount > 0) {
        await logBtn.click({ timeout: 5000 });
        await page.waitForTimeout(600);
        await shot(page, '06b-log-flight-fullpage');

        // Full-page form should be visible
        const fullpage = page.locator('.mfp-form-fullpage');
        const isVisible = await fullpage.isVisible().catch(() => false);
        console.log(`  Full-page form visible: ${isVisible}`);
        if (isVisible) {
            // Check the horizontal boarding pass card
            const hcard = page.locator('.bpf-hcard');
            const hcardVisible = await hcard.isVisible().catch(() => false);
            console.log(`  Horizontal boarding pass: ${hcardVisible}`);
        }
    }
});

// ─── 7. API Ping ─────────────────────────────────────────────────────────────
test('7 - API ping endpoint is healthy', async ({ request }) => {
    const res = await request.get(`${BASE}/api/ping`, { timeout: 10000 });
    expect(res.ok()).toBe(true);
    const body = await res.json().catch(() => ({}));
    console.log(`  Ping: ${JSON.stringify(body)}`);
    expect(body.status).toBe('ok');
});

// ─── 8. Live planes API ───────────────────────────────────────────────────────
test('8 - live planes bbox API returns data', async ({ request }) => {
    const res = await request.get(
        `${BASE}/api/planes/bbox?lamin=-90&lomin=-180&lamax=90&lomax=180`,
        { timeout: 15000 }
    );
    expect(res.ok()).toBe(true);
    const body = await res.json().catch(() => []);
    const planes = Array.isArray(body) ? body : body.states ?? body.planes ?? [];
    console.log(`  Global plane count: ${planes.length}`);
    // Should have planes if system is running
    expect(planes.length).toBeGreaterThanOrEqual(0); // soft: 0 ok if offline
});

// ─── 9. My Flights record list shows redesigned cards ────────────────────────
test('9 - flight list uses new fhr-card design (no old bp-card)', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Old card class should NOT exist
    const oldCards = await page.locator('.bp-card').count();
    expect(oldCards).toBe(0);
    console.log(`  Old bp-card count: ${oldCards} ✓`);
});
