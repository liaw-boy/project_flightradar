// @ts-check
import { test, expect } from '@playwright/test';

const SCREENSHOT_DIR = 'G:/project_flightradar/pw-screenshots';

test.describe('Flight Trail Deep Investigation', () => {
    test('click aircraft and observe trail rendering', async ({ page }) => {
        test.setTimeout(180000);

        const trackRelatedMessages = [];
        const consoleErrors = [];

        page.on('console', (msg) => {
            const text = msg.text();
            const type = msg.type();
            if (type === 'error') consoleErrors.push(`[ERROR] ${text}`);
            if (/track|trail|stale|session|backfill|flight.*path|duplicate/i.test(text)) {
                trackRelatedMessages.push(`[${type.toUpperCase()}] ${text}`);
            }
        });
        page.on('pageerror', (err) => {
            consoleErrors.push(`[PAGE_ERROR] ${err.message}`);
        });

        // ── Navigate ───────────────────────────────────────────────────────────
        await page.goto('http://localhost:3005', { waitUntil: 'load', timeout: 30000 });
        await page.waitForSelector('.leaflet-container', { timeout: 15000 });

        // Wait 8s for WebSocket aircraft data + backfill to arrive
        console.log('Waiting 8 seconds for aircraft + track backfill...');
        await page.waitForTimeout(8000);

        // ── Screenshot 1: Overview with aircraft visible ───────────────────────
        await page.screenshot({ path: `${SCREENSHOT_DIR}/trail_overview.png` });
        console.log('Saved trail_overview.png');

        // ── Try to find and click an aircraft via JS ───────────────────────────
        // Query the app state to get first aircraft's position
        const aircraftPos = await page.evaluate(() => {
            // Look for Leaflet map instance
            const mapEl = document.querySelector('.leaflet-container');
            if (!mapEl || !mapEl._leaflet_id) return null;

            // Try to access the Leaflet map instance from the DOM element
            const leafletMaps = Object.values(window).filter(
                (v) => v && typeof v === 'object' && typeof v.latLngToContainerPoint === 'function'
            );
            if (leafletMaps.length === 0) return null;
            const map = leafletMaps[0];

            // Get the map center as a fallback click target
            const center = map.getCenter();
            const centerPx = map.latLngToContainerPoint(center);
            return { lat: center.lat, lng: center.lng, x: centerPx.x, y: centerPx.y, source: 'center' };
        });

        console.log('Map center info:', JSON.stringify(aircraftPos));

        // ── Use React fiber to enumerate rendered planes ───────────────────────
        const planePositions = await page.evaluate(() => {
            // Try to find plane data from React state or window globals
            const results = [];

            // Check if app exposes any global plane state
            const globalKeys = Object.keys(window).filter(
                (k) => /plane|flight|aircraft/i.test(k) && typeof window[k] === 'object'
            );
            console.log('Global plane-related keys:', globalKeys.join(', ') || 'none');

            return results;
        });

        // ── Click on each aircraft icon in the plane list sidebar ──────────────
        // The sidebar shows callsigns — clicking a row should select the aircraft
        const sidebarRows = page.locator('[class*="plane-row"], [class*="planeRow"], [class*="flight-row"]');
        const rowCount = await sidebarRows.count();
        console.log(`Sidebar rows found: ${rowCount}`);

        if (rowCount > 0) {
            // Click the first row in the sidebar
            await sidebarRows.first().click();
            await page.waitForTimeout(2000);
            console.log('Clicked first sidebar row');

            await page.screenshot({ path: `${SCREENSHOT_DIR}/trail_selected.png` });
            console.log('Saved trail_selected.png (via sidebar row click)');
        } else {
            // Fallback: click directly on the canvas using direct hit-test
            // Taiwan/Asia region — aircraft are around this area based on overview
            const viewport = page.viewportSize();

            // The overview shows aircraft clustered around Taiwan's north coast area
            // Based on the overview screenshot, aircraft are roughly at these pixel regions:
            const candidateClicks = [
                { x: 270, y: 200 },   // upper-left cluster
                { x: 340, y: 60 },    // top-center area
                { x: 190, y: 155 },   // left side
                { x: 225, y: 225 },   // center-left
                { x: 280, y: 250 },   // center
                { x: 300, y: 280 },   // slightly lower center
            ];

            for (const pt of candidateClicks) {
                await page.mouse.click(pt.x, pt.y);
                await page.waitForTimeout(1200);

                // Check if an aircraft was selected (status bar changes, sidebar opens, etc.)
                const statusText = await page.locator('[class*="status"], [class*="Status"]').first().textContent().catch(() => '');
                const hasDetailPanel = await page.locator('[class*="detail"], [class*="Detail"], [class*="info-panel"]').count();

                console.log(`Click at (${pt.x},${pt.y}): status="${statusText}", detailPanel=${hasDetailPanel}`);

                // Check if the topbar aircraft count changed or sidebar shows details
                const topbarText = await page.locator('[class*="topbar"], [class*="TopBar"], header').first().textContent().catch(() => '');
                if (/\bN\b|\bDATA\b/.test(topbarText) === false) {
                    console.log(`Possible aircraft selected at (${pt.x},${pt.y})`);
                    break;
                }
            }

            await page.screenshot({ path: `${SCREENSHOT_DIR}/trail_selected.png` });
            console.log('Saved trail_selected.png (via canvas click fallback)');
        }

        // ── Zoom in 3 levels ───────────────────────────────────────────────────
        const mapEl = page.locator('.leaflet-container').first();
        await mapEl.click();
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press('+');
            await page.waitForTimeout(600);
        }
        await page.waitForTimeout(1500);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/trail_zoomed.png` });
        console.log('Saved trail_zoomed.png');

        // ── Zoom in 3 more levels to see individual trail segments ─────────────
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press('+');
            await page.waitForTimeout(600);
        }
        await page.waitForTimeout(2000);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/trail_zoomed_close.png` });
        console.log('Saved trail_zoomed_close.png');

        // ── Investigate track API for a specific aircraft ──────────────────────
        // Get one icao24 from the stats or attempt to call API
        let sampleIcao = null;
        try {
            const tracksResp = await page.request.get('http://localhost:3000/api/tracks?limit=1');
            if (tracksResp.ok()) {
                const body = await tracksResp.json();
                console.log('Sample track entry:', JSON.stringify(body).slice(0, 300));
            } else {
                console.log('/api/tracks status:', tracksResp.status());
                const text = await tracksResp.text();
                console.log('/api/tracks body:', text.slice(0, 200));
            }
        } catch (e) {
            console.log('/api/tracks error:', e.message);
        }

        // Try individual aircraft track endpoints from the known ICAO24 in backfill logs
        const knownIcaos = ['780a58', '750260', '8990c0', '71c593', '7584a8'];
        for (const icao of knownIcaos.slice(0, 2)) {
            try {
                const resp = await page.request.get(`http://localhost:3000/api/tracks?icao24=${icao}`);
                if (resp.ok()) {
                    const body = await resp.json();
                    const points = Array.isArray(body) ? body : (body.data || []);
                    console.log(`Track for ${icao}: ${points.length} points`);

                    // Check for multiple sessions (possible stale trail issue)
                    const sessions = [...new Set(points.map((p) => p.sessionId || p.session_id || 'unknown'))];
                    console.log(`  Sessions for ${icao}:`, sessions);
                } else {
                    console.log(`Track for ${icao}: HTTP ${resp.status()}`);
                }
            } catch (e) {
                console.log(`Track for ${icao} error:`, e.message);
            }
        }

        // ── Check FlightSession collection for active/stale sessions ──────────
        try {
            const healthResp = await page.request.get('http://localhost:3000/api/health');
            if (healthResp.ok()) {
                const body = await healthResp.json();
                console.log('Health:', JSON.stringify(body, null, 2));
            }
        } catch (e) {
            console.log('Health check error:', e.message);
        }

        // ── Final zoom-out for context ─────────────────────────────────────────
        await mapEl.click();
        for (let i = 0; i < 8; i++) {
            await page.keyboard.press('-');
            await page.waitForTimeout(300);
        }
        await page.waitForTimeout(1000);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/trail_zoomed_out.png` });
        console.log('Saved trail_zoomed_out.png');

        // ── Final Report ───────────────────────────────────────────────────────
        console.log('\n=== DEEP INVESTIGATION REPORT ===');
        console.log(`Console Errors (${consoleErrors.length}):`);
        consoleErrors.slice(0, 20).forEach((e) => console.log(' ', e));

        console.log(`\nTrack/Trail Console Messages (${trackRelatedMessages.length}):`);
        trackRelatedMessages.slice(0, 40).forEach((m) => console.log(' ', m));
        if (trackRelatedMessages.length > 40) {
            console.log(`  ... and ${trackRelatedMessages.length - 40} more`);
        }
        console.log('=== END DEEP REPORT ===');

        await expect(page.locator('.leaflet-container')).toBeVisible();
    });
});
