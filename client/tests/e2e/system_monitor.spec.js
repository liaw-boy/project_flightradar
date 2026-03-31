/**
 * AEROSTRAT 完整系統監控測試
 * 驗證：後端資料流、API 來源、WebSocket、地圖渲染、飛機數量
 *
 * 執行：cd client && npx playwright test tests/e2e/system_monitor.spec.js --headed
 */
import { test, expect } from '@playwright/test';

const BACKEND = 'http://localhost:3000';
const FRONTEND = 'http://localhost:3005';

// ── 工具函數 ──────────────────────────────────────────────────────────────
function fmt(n) { return typeof n === 'number' ? n.toLocaleString() : String(n ?? 'N/A'); }
function timeAgo(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    return s < 60 ? `${s}s ago` : `${Math.round(s/60)}m ago`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 後端 API 健康檢查
// ═══════════════════════════════════════════════════════════════════════════
test('1. 後端 API 健康檢查', async ({ request }) => {
    // Health
    const health = await request.get(`${BACKEND}/api/health`);
    expect(health.ok()).toBeTruthy();
    const hj = await health.json();
    console.log('\n── Health ──');
    console.log('  狀態:', hj.status);
    console.log('  運行時間:', Math.round(hj.uptime / 60), '分鐘');
    console.log('  快取飛機數:', fmt(hj.cacheSize));
    console.log('  活躍 Session:', fmt(hj.activeSessions));
    expect(hj.status).toBe('ok');

    // Stats
    const stats = await request.get(`${BACKEND}/api/stats`);
    expect(stats.ok()).toBeTruthy();
    const sj = await stats.json();

    console.log('\n── Source Health (v11.0) ──');
    const sh = sj.sourceHealth || {};
    const sources = ['adsb.fi-snap', 'adsb.lol', 'al-point', 're-api', 'al-mil', 'al-ladd', 'adsb.fi-v3'];
    for (const src of sources) {
        const s = sh[src];
        if (!s) { console.log(`  ${src}: 尚未執行`); continue; }
        const cbStatus = (s.cbUntil || 0) > Date.now() ? '🔴 CB 開啟' : '🟢 正常';
        console.log(`  ${src}: ${cbStatus} | 上次: ${fmt(s.lastCount)} 架 | 延遲: ${s.lastLatency}ms | ${timeAgo(s.lastOk)}`);
    }

    console.log('\n── OpenSky 帳號 ──');
    for (const a of (sj.accounts || [])) {
        console.log(`  ${a.user}: 剩餘 ${fmt(a.remainingCredits)} | 失敗 ${a.consecutiveFails}次`);
    }

    console.log('\n── 全域統計 ──');
    console.log('  總飛機數:', fmt(sj.totalPlanes));
    console.log('  API 總呼叫:', fmt(sj.totalCalls));
    console.log('  運行', sj.uptimeMinutes, '分鐘');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 資料來源即時 API 測試
// ═══════════════════════════════════════════════════════════════════════════
test('2. 各資料來源即時回應測試', async ({ request }) => {
    console.log('\n── 直接 API 測試 ──');

    const sources = [
        { name: 'adsb.fi snapshot', url: 'https://opendata.adsb.fi/api/v2/snapshot', key: 'ac' },
        { name: 'adsb.lol global',  url: 'https://api.adsb.lol/v2/lat/0/lon/0/dist/99999', key: 'ac' },
        { name: 'AL /mil',          url: 'https://api.airplanes.live/v2/mil', key: 'ac' },
        { name: 're-api 台灣',      url: 'https://re-api.adsb.lol?circle=25.04,121.53,500', key: 'aircraft' },
    ];

    for (const src of sources) {
        const t0 = Date.now();
        try {
            const r = await request.get(src.url, { timeout: 12000 });
            const ms = Date.now() - t0;
            const j = r.ok() ? await r.json() : null;
            const count = j ? (j[src.key] || []).length : 0;
            const status = r.ok() ? '✅' : `❌ HTTP ${r.status()}`;
            console.log(`  ${status} ${src.name}: ${fmt(count)} 架 | ${ms}ms`);
            if (r.ok()) expect(count).toBeGreaterThan(0);
        } catch (e) {
            console.log(`  ⚠️  ${src.name}: ${e.message.slice(0, 50)}`);
        }
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. BBox API 回應速度與資料品質
// ═══════════════════════════════════════════════════════════════════════════
test('3. BBox API 速度與資料品質', async ({ request }) => {
    const t0 = Date.now();
    const r = await request.get(`${BACKEND}/api/planes/bbox?lamin=20&lomin=115&lamax=27&lomax=125`);
    const ms = Date.now() - t0;
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    const planes = j.states || [];

    console.log('\n── BBox API (台灣周邊) ──');
    console.log('  回應時間:', ms, 'ms（應 <100ms）');
    console.log('  飛機數:', planes.length);
    console.log('  資料新鮮度:', j.stale ? '🔴 過期' : '🟢 新鮮');
    console.log('  全球快取時間:', new Date(j.globalLastUpdate * 1000).toLocaleTimeString());

    expect(ms).toBeLessThan(200);

    if (planes.length > 0) {
        const sample = planes[0];
        console.log('\n  樣本飛機欄位完整度:');
        const fields = {
            '位置 lat/lon': !!(sample.lat && sample.lng),
            '高度': sample.altitude != null,
            '速度 velocity': sample.velocity != null,
            '航向 heading': sample.heading != null,
            '呼號 callsign': !!sample.callsign,
            '機號 registration': !!sample.registration,
            '機型 typecode': !!sample.typecode,
            '說明 description': !!sample.description,
            '年份 year': !!sample.year,
            '航公 operator': !!sample.operator,
        };
        for (const [name, ok] of Object.entries(fields)) {
            console.log(`    ${ok ? '✅' : '⬜'} ${name}`);
        }

        // 欄位覆蓋率統計
        const descPct = Math.round(planes.filter(p => p.description).length / planes.length * 100);
        const regPct  = Math.round(planes.filter(p => p.registration).length / planes.length * 100);
        const tcPct   = Math.round(planes.filter(p => p.typecode).length / planes.length * 100);
        console.log(`\n  Fleet 欄位覆蓋: description=${descPct}% | registration=${regPct}% | typecode=${tcPct}%`);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. 前端載入與地圖渲染
// ═══════════════════════════════════════════════════════════════════════════
test('4. 前端載入與地圖渲染', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    const networkErrors = [];
    page.on('response', resp => {
        if (resp.status() >= 400) networkErrors.push(`${resp.status()} ${resp.url()}`);
    });

    console.log('\n── 前端載入 ──');
    const t0 = Date.now();
    await page.goto(FRONTEND, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('  載入時間:', Date.now() - t0, 'ms');

    // 等待地圖容器
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 15000 });
    console.log('  ✅ Leaflet 地圖容器可見');

    // 等待飛機圖示出現
    try {
        await page.waitForFunction(() => {
            const canvas = document.querySelector('canvas');
            if (!canvas) return false;
            const ctx = canvas.getContext('2d');
            return canvas.width > 0 && canvas.height > 0;
        }, { timeout: 20000 });
        console.log('  ✅ Canvas 渲染層就緒');
    } catch(e) {
        console.log('  ⚠️  Canvas 渲染層未確認');
    }

    // 取得飛機計數
    const planeCount = await page.evaluate(() => {
        // 嘗試從 React state / window 全域讀取
        if (window.__planeCount !== undefined) return window.__planeCount;
        const badges = document.querySelectorAll('[class*="count"], [class*="badge"], [class*="plane"]');
        for (const b of badges) {
            const n = parseInt(b.textContent);
            if (!isNaN(n) && n > 0) return n;
        }
        return null;
    });
    console.log('  UI 飛機計數:', planeCount ?? '(未能取得)');

    // Console 錯誤
    const fatalErrors = consoleErrors.filter(e =>
        !e.includes('favicon') && !e.includes('404') &&
        !e.includes('ResizeObserver') && !e.includes('Non-Error promise')
    );
    if (fatalErrors.length > 0) {
        console.log('  ⚠️  Console 錯誤:');
        fatalErrors.slice(0, 5).forEach(e => console.log('    ', e.slice(0, 100)));
    } else {
        console.log('  ✅ 無 console 錯誤');
    }

    // 截圖
    await page.screenshot({ path: 'pw-screenshots/system_monitor_map.png', fullPage: false });
    console.log('  📸 截圖已儲存: pw-screenshots/system_monitor_map.png');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. WebSocket 即時資料流測試
// ═══════════════════════════════════════════════════════════════════════════
test('5. WebSocket 即時資料流', async ({ page }) => {
    console.log('\n── WebSocket 測試 ──');

    await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });

    // 監聽 WebSocket
    let wsConnected = false;
    let msgCount = 0;
    let firstMsg = null;

    page.on('websocket', ws => {
        wsConnected = true;
        console.log('  ✅ WebSocket 連線建立:', ws.url());
        ws.on('framereceived', frame => {
            msgCount++;
            if (msgCount === 1) firstMsg = { size: frame.payload?.length || 0, time: Date.now() };
        });
    });

    // 等待 WebSocket 活動
    await page.waitForTimeout(8000);

    console.log('  WebSocket 連線:', wsConnected ? '✅ 已連線' : '❌ 未連線');
    console.log('  收到訊息數 (8s內):', msgCount);
    if (firstMsg) console.log('  首個訊息大小:', firstMsg.size, 'bytes');

    expect(wsConnected).toBeTruthy();
    expect(msgCount).toBeGreaterThan(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. 資料更新頻率測試 (30s 觀察)
// ═══════════════════════════════════════════════════════════════════════════
test('6. 資料更新頻率 (30s 觀察)', async ({ request }) => {
    console.log('\n── 30 秒資料更新觀察 ──');

    const snapshots = [];
    for (let i = 0; i < 6; i++) {
        const r = await request.get(`${BACKEND}/api/planes/bbox?lamin=18&lomin=110&lamax=30&lomax=130`);
        if (r.ok()) {
            const j = await r.json();
            snapshots.push({
                t: new Date().toLocaleTimeString(),
                count: (j.states || []).length,
                ts: j.globalLastUpdate,
                stale: j.stale,
            });
        }
        if (i < 5) await new Promise(r => setTimeout(r, 5000));
    }

    console.log('  時間          飛機數  新鮮');
    for (const s of snapshots) {
        console.log(`  ${s.t}  ${String(s.count).padStart(5)}   ${s.stale ? '🔴' : '🟢'}`);
    }

    const counts = snapshots.map(s => s.count);
    const avg = Math.round(counts.reduce((a,b) => a+b, 0) / counts.length);
    const changing = new Set(snapshots.map(s => s.ts)).size > 1;
    console.log(`\n  平均飛機數: ${avg}`);
    console.log(`  資料有在更新: ${changing ? '✅ 是' : '❌ 否（時間戳不變）'}`);

    expect(avg).toBeGreaterThan(0);
    expect(changing).toBeTruthy();
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. 點擊飛機 → Sidebar 資料完整度
// ═══════════════════════════════════════════════════════════════════════════
test('7. 點擊飛機 → Sidebar 資料', async ({ page }) => {
    console.log('\n── Sidebar 資料完整度測試 ──');

    await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000); // 等待飛機載入

    // 嘗試點擊地圖中央附近
    const map = page.locator('.leaflet-container');
    await map.click({ position: { x: 400, y: 300 } });
    await page.waitForTimeout(1000);

    const sidebar = page.locator('[class*="sidebar"], [class*="Sidebar"]').first();
    if (await sidebar.isVisible()) {
        const text = await sidebar.textContent();
        console.log('  ✅ Sidebar 開啟');
        const hasCallsign = /[A-Z]{2,3}\d{3,4}/.test(text);
        const hasAlt = /\d{3,5}/.test(text);
        console.log('  包含呼號:', hasCallsign ? '✅' : '⬜');
        console.log('  包含高度:', hasAlt ? '✅' : '⬜');
        await page.screenshot({ path: 'pw-screenshots/system_monitor_sidebar.png' });
        console.log('  📸 Sidebar 截圖已儲存');
    } else {
        console.log('  ℹ️  未點中飛機，跳過 Sidebar 測試');
    }
});
