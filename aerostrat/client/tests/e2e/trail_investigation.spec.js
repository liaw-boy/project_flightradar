// @ts-check
import { test, expect } from '@playwright/test';
import path from 'path';

const SCREENSHOT_DIR = 'G:/project_flightradar/pw-screenshots';

test.describe('Flight Trail Investigation', () => {
    test('capture trail rendering at multiple zoom levels', async ({ page }) => {
        test.setTimeout(120000);
        const consoleErrors = [];
        const trackRelatedMessages = [];

        // Capture all console output
        page.on('console', (msg) => {
            const text = msg.text();
            const type = msg.type();
            if (type === 'error') {
                consoleErrors.push(`[ERROR] ${text}`);
            }
            if (/track|trail|stale|session|flight.*path|path.*flight/i.test(text)) {
                trackRelatedMessages.push(`[${type.toUpperCase()}] ${text}`);
            }
        });

        page.on('pageerror', (err) => {
            consoleErrors.push(`[PAGE ERROR] ${err.message}`);
        });

        // ── Step 1: Navigate and wait for initial load ──────────────────────
        console.log('Step 1: Navigating to http://localhost:3005');
        await page.goto('http://localhost:3005', { waitUntil: 'load', timeout: 30000 });

        // Wait for the Leaflet map container to be present
        await page.waitForSelector('#map, .leaflet-container, [class*="leaflet"]', {
            timeout: 15000,
        });
        console.log('Map container detected');

        // Wait 5 seconds for aircraft data to populate via WebSocket
        console.log('Waiting 5 seconds for aircraft data to load...');
        await page.waitForTimeout(5000);

        // ── Step 2: Full overview screenshot ────────────────────────────────
        console.log('Step 2: Taking overview screenshot');
        await page.screenshot({
            path: `${SCREENSHOT_DIR}/trail_overview.png`,
            fullPage: false,
        });
        console.log('Saved: trail_overview.png');

        // Count how many aircraft icons are visible on the canvas
        const canvasCount = await page.locator('canvas').count();
        console.log(`Canvas elements found: ${canvasCount}`);

        // ── Step 3: Zoom in on a region likely to have aircraft ──────────────
        // Get current map center and zoom in programmatically via Leaflet
        console.log('Step 3: Zooming in on map to reveal trail details');

        // Try to zoom in using keyboard shortcuts first (+/= key)
        const mapContainer = page.locator('.leaflet-container').first();
        await mapContainer.click(); // focus the map
        await page.keyboard.press('+');
        await page.waitForTimeout(600);
        await page.keyboard.press('+');
        await page.waitForTimeout(600);
        await page.keyboard.press('+');
        await page.waitForTimeout(600);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/trail_zoomed.png`,
            fullPage: false,
        });
        console.log('Saved: trail_zoomed.png');

        // ── Step 4: Attempt to click on an aircraft icon ────────────────────
        // We need to find a clickable area on the canvas — try center of viewport
        // and surrounding quadrants since aircraft positions are unknown
        console.log('Step 4: Attempting to click an aircraft on the canvas');

        const viewport = page.viewportSize();
        const centerX = viewport.width / 2;
        const centerY = viewport.height / 2;

        // Probe several positions to find an aircraft
        const probePoints = [
            { x: centerX, y: centerY },
            { x: centerX - 200, y: centerY - 100 },
            { x: centerX + 200, y: centerY - 100 },
            { x: centerX - 200, y: centerY + 100 },
            { x: centerX + 200, y: centerY + 100 },
            { x: centerX, y: centerY - 200 },
            { x: centerX, y: centerY + 200 },
            { x: centerX - 350, y: centerY },
            { x: centerX + 350, y: centerY },
        ];

        let aircraftClicked = false;

        for (const pt of probePoints) {
            await page.mouse.click(pt.x, pt.y);
            await page.waitForTimeout(800);

            // Check if sidebar or hover card appeared (indicates aircraft was clicked)
            const sidebarVisible = await page.locator(
                '[class*="sidebar"], [class*="Sidebar"], [class*="flight-info"], [class*="FlightInfo"], [class*="detail"]'
            ).count();

            const hoverCardVisible = await page.locator(
                '[class*="hover"], [class*="HoverCard"], [class*="tooltip"]'
            ).count();

            if (sidebarVisible > 0 || hoverCardVisible > 0) {
                console.log(`Aircraft clicked at (${pt.x}, ${pt.y}) — sidebar/card appeared`);
                aircraftClicked = true;
                break;
            }
        }

        if (!aircraftClicked) {
            console.log('No aircraft found via probe clicks — sidebar may not have opened');
        }

        // ── Step 5: Screenshot with selected aircraft and trail ──────────────
        console.log('Step 5: Taking screenshot of selected aircraft state');
        await page.waitForTimeout(1000);
        await page.screenshot({
            path: `${SCREENSHOT_DIR}/trail_selected.png`,
            fullPage: false,
        });
        console.log('Saved: trail_selected.png');

        // ── Step 6: Check for track data from API ────────────────────────────
        console.log('Step 6: Checking /api/tracks endpoint for stale track data');

        let trackApiResponse = null;
        try {
            const response = await page.request.get('http://localhost:3000/api/tracks');
            if (response.ok()) {
                const body = await response.json();
                const trackCount = Array.isArray(body) ? body.length :
                    (body.data && Array.isArray(body.data) ? body.data.length : 'unknown');
                console.log(`/api/tracks returned ${trackCount} track records`);
                trackApiResponse = { status: response.status(), count: trackCount };
            } else {
                console.log(`/api/tracks returned HTTP ${response.status()}`);
            }
        } catch (e) {
            console.log(`/api/tracks fetch error: ${e.message}`);
        }

        // ── Step 7: Check FlightSession data for stale sessions ──────────────
        console.log('Step 7: Checking /api/stats for session state info');

        let statsResponse = null;
        try {
            const response = await page.request.get('http://localhost:3000/api/stats');
            if (response.ok()) {
                const body = await response.json();
                console.log('Stats:', JSON.stringify(body, null, 2));
                statsResponse = body;
            }
        } catch (e) {
            console.log(`/api/stats fetch error: ${e.message}`);
        }

        // ── Step 8: Zoom out fully and capture wide view ─────────────────────
        console.log('Step 8: Zooming out to see full global trail picture');
        await mapContainer.click();
        for (let i = 0; i < 4; i++) {
            await page.keyboard.press('-');
            await page.waitForTimeout(400);
        }
        await page.waitForTimeout(1000);

        await page.screenshot({
            path: `${SCREENSHOT_DIR}/trail_zoomed_out.png`,
            fullPage: false,
        });
        console.log('Saved: trail_zoomed_out.png');

        // ── Report ────────────────────────────────────────────────────────────
        console.log('\n=== INVESTIGATION REPORT ===');

        console.log(`\nConsole Errors (${consoleErrors.length}):`);
        if (consoleErrors.length === 0) {
            console.log('  None');
        } else {
            consoleErrors.forEach((e) => console.log(' ', e));
        }

        console.log(`\nTrack/Trail Related Console Messages (${trackRelatedMessages.length}):`);
        if (trackRelatedMessages.length === 0) {
            console.log('  None');
        } else {
            trackRelatedMessages.slice(0, 30).forEach((m) => console.log(' ', m));
            if (trackRelatedMessages.length > 30) {
                console.log(`  ... and ${trackRelatedMessages.length - 30} more`);
            }
        }

        console.log('\nAPI Summary:');
        console.log('  /api/tracks:', trackApiResponse ? JSON.stringify(trackApiResponse) : 'unavailable');
        console.log('  /api/stats:', statsResponse ? 'available' : 'unavailable');

        console.log('\nScreenshots saved:');
        console.log('  trail_overview.png   — initial state, all aircraft visible');
        console.log('  trail_zoomed.png     — zoomed in 3 levels');
        console.log('  trail_selected.png   — after attempting aircraft click');
        console.log('  trail_zoomed_out.png — zoomed out 4 levels from zoomed state');
        console.log('=== END REPORT ===\n');

        // Basic assertion: page should have loaded without crashing
        await expect(page.locator('.leaflet-container')).toBeVisible();
    });
});
