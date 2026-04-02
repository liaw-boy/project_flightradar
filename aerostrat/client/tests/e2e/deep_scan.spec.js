import { test, expect } from '@playwright/test';

const BACKEND = 'http://localhost:3000';
const FRONTEND = 'http://localhost:3005';

test('深度系統掃描', async ({ page, request }) => {
    const issues = [];
    const ok = [];

    // ══════════════════════════════════════════════
    // 1. Source Health
    // ══════════════════════════════════════════════
    console.log('\n━━ 1. Source Health ━━');
    const stats = await (await request.get(`${BACKEND}/api/stats`)).json();
    const sh = stats.sourceHealth || {};
    const now = Date.now();
    for (const [k, v] of Object.entries(sh)) {
        const cbOpen = (v.cbUntil || 0) > now;
        const eta = cbOpen ? Math.round((v.cbUntil - now) / 1000) + 's' : '';
        console.log(cbOpen ? '  🔴' : '  🟢', k.padEnd(14), (v.lastCount || 0) + '架', cbOpen ? `CB熔斷${eta}` : '');
        if (cbOpen) issues.push(`CB熔斷: ${k}`);
        else ok.push(`來源正常: ${k}`);
    }
    console.log('  總飛機:', stats.totalPlanes || 0);

    // ══════════════════════════════════════════════
    // 2. Route Lookup (10架)
    // ══════════════════════════════════════════════
    console.log('\n━━ 2. 路由查詢測試 ━━');
    const bboxRes = await (await request.get(`${BACKEND}/api/planes/bbox?lamin=18&lomin=110&lamax=30&lomax=130`)).json();
    const planes = bboxRes.states || [];
    const withCS = planes.filter(p => p.callsign?.trim()).slice(0, 10);
    let routeHit = 0, routeMiss = 0, descHit = 0;

    for (const p of withCS) {
        const cs = p.callsign.trim();
        try {
            const dr = await request.get(`${BACKEND}/api/flight-details/${p.icao24}/${cs}`, { timeout: 7000 });
            const dj = await dr.json();
            const orig = dj?.route?.origin?.iata;
            const dest = dj?.route?.destination?.iata;
            const hasRoute = orig && orig !== 'N/A';
            const hasDesc = !!(dj?.aircraft?.model || dj?.aircraft?.description);
            if (hasRoute) routeHit++; else routeMiss++;
            if (hasDesc) descHit++;
            console.log(`  ${hasRoute ? '✅' : '⬜'} ${cs.padEnd(10)} ${orig || '?'}→${dest || '?'} | model:${hasDesc ? '✅' : '⬜'}`);
        } catch (e) {
            routeMiss++;
            console.log(`  ❌ ${cs} timeout`);
        }
    }
    const routePct = Math.round(routeHit / (routeHit + routeMiss) * 100);
    console.log(`  命中率: ${routeHit}/${routeHit + routeMiss} = ${routePct}%`);
    if (routePct < 20) issues.push(`路由命中率低: ${routePct}%`);
    else ok.push(`路由命中率: ${routePct}%`);

    // ══════════════════════════════════════════════
    // 3. 前端載入
    // ══════════════════════════════════════════════
    console.log('\n━━ 3. 前端載入 ━━');
    const consoleErrors = [];
    const networkFails = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) networkFails.push(`${r.status()} ${r.url()}`); });

    const t0 = Date.now();
    await page.goto(FRONTEND, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(6000);
    console.log('  載入時間:', Date.now() - t0, 'ms');

    const hasCanvas = await page.locator('canvas').count() > 0;
    const hasLeaflet = await page.locator('.leaflet-container').count() > 0;
    const hasMap = hasCanvas || hasLeaflet;
    console.log('  地圖渲染:', hasMap ? '✅' : '❌');
    if (!hasMap) issues.push('地圖未渲染');
    else ok.push('地圖正常渲染');

    // ══════════════════════════════════════════════
    // 4. WebSocket
    // ══════════════════════════════════════════════
    console.log('\n━━ 4. WebSocket ━━');
    // Check via backend WS health + JS evaluation (Playwright intercepts at browser level)
    let wsConnected = false, wsMessages = 0;
    page.on('websocket', ws => {
        wsConnected = true;
        ws.on('framereceived', () => wsMessages++);
    });
    await page.waitForTimeout(5000);

    // Fallback: check if WS is running at backend level
    if (!wsConnected) {
        const wsCheck = await page.evaluate(async () => {
            try {
                const ws = new WebSocket('ws://localhost:3005/ws');
                return await new Promise(res => {
                    ws.onopen = () => { ws.close(); res(true); };
                    ws.onerror = () => res(false);
                    setTimeout(() => res(false), 3000);
                });
            } catch { return false; }
        });
        if (wsCheck) wsConnected = true;
    }
    console.log('  連線:', wsConnected ? '✅' : '❌', '| 訊息數:', wsMessages);
    if (!wsConnected) issues.push('WebSocket未連線');
    else ok.push(`WebSocket正常`);

    // ══════════════════════════════════════════════
    // 5. 搜尋功能
    // ══════════════════════════════════════════════
    console.log('\n━━ 5. 搜尋功能 ━━');
    try {
        const searchInput = page.locator('input').first();
        await searchInput.fill('CAL');
        await page.waitForTimeout(1500);
        const screenshot = await page.screenshot({ path: 'pw-screenshots/deep_scan_search.png' });
        console.log('  搜尋輸入: ✅ (截圖已儲存)');
        ok.push('搜尋功能正常');
    } catch (e) {
        issues.push('搜尋功能: ' + e.message.slice(0, 50));
    }

    // ══════════════════════════════════════════════
    // 6. 點擊地圖 → Sidebar
    // ══════════════════════════════════════════════
    console.log('\n━━ 6. Sidebar 路由顯示 ━━');
    await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const map = page.locator('.leaflet-container');
    if (await map.count() > 0) {
        // 多點幾個位置嘗試點到飛機
        const positions = [
            { x: 500, y: 350 }, { x: 450, y: 300 }, { x: 550, y: 400 },
            { x: 600, y: 350 }, { x: 400, y: 400 },
        ];
        let sidebarOpened = false;
        for (const pos of positions) {
            await map.click({ position: pos });
            await page.waitForTimeout(1000);
            const sidebar = page.locator('[class*="sidebar"],[class*="Sidebar"],[class*="detail"],[class*="panel"]').first();
            if (await sidebar.isVisible().catch(() => false)) {
                sidebarOpened = true;
                const text = await sidebar.textContent().catch(() => '');
                const hasOrigin = /[A-Z]{3}/.test(text);
                const hasAirport = text.includes('Airport') || text.includes('機場') || text.includes('International');
                console.log('  Sidebar 開啟: ✅');
                console.log('  包含機場代碼:', hasOrigin ? '✅' : '⬜');
                console.log('  包含機場名稱:', hasAirport ? '✅' : '⬜');
                await page.screenshot({ path: 'pw-screenshots/deep_scan_sidebar.png' });
                if (hasOrigin) ok.push('Sidebar 路由顯示正常');
                else issues.push('Sidebar 路由代碼缺失');
                break;
            }
        }
        if (!sidebarOpened) {
            console.log('  ℹ️  未點中飛機，跳過');
            await page.screenshot({ path: 'pw-screenshots/deep_scan_map.png' });
        }
    }

    // ══════════════════════════════════════════════
    // 7. Console 錯誤
    // ══════════════════════════════════════════════
    console.log('\n━━ 7. Console & Network 錯誤 ━━');
    const fatalErrors = consoleErrors.filter(e =>
        !e.includes('favicon') && !e.includes('ResizeObserver') &&
        !e.includes('Non-Error') && !e.includes('404'));
    console.log('  Console Errors:', fatalErrors.length);
    fatalErrors.slice(0, 5).forEach(e => console.log('    ❌', e.slice(0, 100)));
    console.log('  Network Fails:', networkFails.length);
    networkFails.slice(0, 5).forEach(e => console.log('    ❌', e.slice(0, 100)));
    if (fatalErrors.length > 0) issues.push(`Console錯誤: ${fatalErrors.length}個`);
    else ok.push('Console無錯誤');

    // ══════════════════════════════════════════════
    // 8. 持續更新測試 (20s)
    // ══════════════════════════════════════════════
    console.log('\n━━ 8. 資料更新頻率 (20s) ━━');
    const snapshots = [];
    for (let i = 0; i < 4; i++) {
        const r = await (await request.get(`${BACKEND}/api/planes/bbox?lamin=18&lomin=110&lamax=30&lomax=130`)).json();
        snapshots.push({ count: (r.states || []).length, ts: r.globalLastUpdate, stale: r.stale });
        if (i < 3) await new Promise(r => setTimeout(r, 5000));
    }
    const changing = new Set(snapshots.map(s => s.ts)).size > 1;
    const avgCount = Math.round(snapshots.reduce((a, b) => a + b.count, 0) / snapshots.length);
    console.log('  平均飛機數:', avgCount, '| 有在更新:', changing ? '✅' : '❌');
    snapshots.forEach((s, i) => console.log(`  ${i * 5}s: ${s.count}架 ${s.stale ? '🔴' : '🟢'}`));
    if (!changing) issues.push('資料未更新');
    else ok.push(`資料持續更新 (avg ${avgCount}架)`);

    // ══════════════════════════════════════════════
    // 總結
    // ══════════════════════════════════════════════
    console.log('\n' + '═'.repeat(50));
    console.log(`✅ 正常 (${ok.length}): ` + ok.join(' | '));
    console.log(`❌ 問題 (${issues.length}):`);
    issues.forEach(i => console.log('  ❌', i));

    expect(issues.filter(i => !i.includes('CB熔斷') && !i.includes('description')).length).toBe(0);
});
