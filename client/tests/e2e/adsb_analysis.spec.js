// @ts-check
/**
 * globe.adsb.fi Live Site Analysis
 * Deep inspection of rendering technology, trail system, and data flow
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const ADSB_URL = 'https://globe.adsb.fi';
const OUT_DIR = path.resolve('..', 'pw-screenshots', 'adsb_analysis');

function ensureDir() {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}
async function shot(page, name) {
    ensureDir();
    const p = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: p, fullPage: false });
    console.log(`📸 ${name}`);
    return p;
}

// ─── Test 1: Map rendering technology ────────────────────────────────────────
test('globe.adsb.fi — rendering technology and layer structure', async ({ page }) => {
    await page.goto(ADSB_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(5000);
    await shot(page, '01_initial');

    const info = await page.evaluate(() => {
        const result = {};

        // Rendering library detection
        result.hasLeaflet   = typeof window.L !== 'undefined';
        result.hasOpenLayers = typeof window.ol !== 'undefined';
        result.hasMapboxGL  = typeof window.mapboxgl !== 'undefined';
        result.olVersion    = window.ol?.util?.VERSION || (window.ol ? 'present' : 'absent');

        // Canvas inventory
        const canvases = document.querySelectorAll('canvas');
        result.canvasCount = canvases.length;
        result.canvasList  = Array.from(canvases).map((c, i) => ({
            i, w: c.width, h: c.height, class: c.className, id: c.id || '-'
        }));

        // OL layer groups
        result.olLayers = Array.from(document.querySelectorAll('.ol-layer')).map(el => ({
            id: el.id || '-', class: el.className.replace(/\s+/g,' ')
        }));

        // Key tar1090 globals
        const g1090 = {};
        ['g', 'OLMap', 'layers', 'PlaneObject', 'ColorByAlt',
         'selected_aircraft', 'SelectedAllPlanes', 'tempTrailsTimeout',
         'pTracks', 'showTrace', 'defaultConfig', 'userSettings'].forEach(k => {
            if (window[k] !== undefined) {
                const v = window[k];
                g1090[k] = typeof v === 'function'
                    ? `[Function]`
                    : typeof v === 'object'
                        ? JSON.stringify(v).slice(0, 150)
                        : String(v).slice(0, 150);
            }
        });
        result.tar1090Globals = g1090;

        return result;
    });

    console.log('\n=== RENDERING TECH ===');
    console.log('OpenLayers:', info.olVersion);
    console.log('Leaflet:', info.hasLeaflet);
    console.log('Canvas count:', info.canvasCount);
    info.canvasList.forEach(c => console.log(`  Canvas[${c.i}]: ${c.w}×${c.h}  class="${c.class}"  id="${c.id}"`));
    console.log('\nOL layers:');
    info.olLayers.forEach(l => console.log(`  id="${l.id}"  class="${l.class}"`));
    console.log('\ntar1090 globals:', JSON.stringify(info.tar1090Globals, null, 2));
});

// ─── Test 2: Select aircraft and observe trail behavior ───────────────────────
test('globe.adsb.fi — aircraft selection and trail rendering', async ({ page }) => {
    const networkCalls = [];
    page.on('request', req => {
        const u = req.url();
        if (u.includes('trace') || u.includes('track') || u.includes('history') || u.includes('aircraft')) {
            networkCalls.push({ url: u, method: req.method() });
        }
    });

    await page.goto(ADSB_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(6000);
    await shot(page, '02_loaded');

    // Click map center to try selecting an aircraft
    const mapSel = page.locator('.ol-viewport').first();
    const box = await mapSel.boundingBox().catch(() => null);

    let selectedCallsign = '';
    if (box) {
        const pts = [
            [0.5,0.5],[0.45,0.45],[0.55,0.45],[0.4,0.5],[0.6,0.5],
            [0.5,0.4],[0.5,0.6],[0.35,0.4],[0.65,0.4],[0.4,0.6],
        ];
        for (const [rx, ry] of pts) {
            await page.mouse.click(box.x + box.width * rx, box.y + box.height * ry);
            await page.waitForTimeout(1000);
            const cs = await page.locator('#selected_callsign').textContent().catch(() => '');
            if (cs?.trim()) { selectedCallsign = cs.trim(); break; }
        }
    }

    console.log('\n✈️  Selected aircraft:', selectedCallsign || '(none hit)');
    await page.waitForTimeout(2000);
    await shot(page, '03_selected');

    // Inspect the selected aircraft's trail data
    const trailInfo = await page.evaluate(() => {
        if (!window.selected_aircraft) return { error: 'no selected_aircraft global' };

        const a = window.selected_aircraft;
        return {
            icao24:           a.icao,
            callsign:         a.flight,
            altitude:         a.altitude,
            speed:            a.gs,
            track:            a.track,
            dataSource:       a.adsbCategory || a.dataSource || a.type,
            trackSegsCount:   a.track_linesegs?.length,
            traceCount:       a.trace?.length,
            historySize:      a.history_size,
            // First and last segment if available
            firstSeg: a.track_linesegs?.[0] ? {
                altitude:   a.track_linesegs[0].altitude,
                estimated:  a.track_linesegs[0].estimated,
                ground:     a.track_linesegs[0].ground,
                dataSource: a.track_linesegs[0].dataSource,
                ts:         a.track_linesegs[0].ts,
                coordCount: a.track_linesegs[0].fixed?.getCoordinates?.()?.length,
            } : null,
            lastSeg: a.track_linesegs?.at(-1) ? {
                altitude:   a.track_linesegs.at(-1).altitude,
                estimated:  a.track_linesegs.at(-1).estimated,
                ground:     a.track_linesegs.at(-1).ground,
                dataSource: a.track_linesegs.at(-1).dataSource,
                ts:         a.track_linesegs.at(-1).ts,
                coordCount: a.track_linesegs.at(-1).fixed?.getCoordinates?.()?.length,
            } : null,
        };
    });

    console.log('\n=== TRAIL DATA STRUCTURE ===');
    console.log(JSON.stringify(trailInfo, null, 2));

    console.log('\n=== NETWORK CALLS (trace/track/history) ===');
    networkCalls.forEach(c => console.log(`  ${c.method} ${c.url}`));
});

// ─── Test 3: Inspect trail color scheme and global config ─────────────────────
test('globe.adsb.fi — trail color config and rendering settings', async ({ page }) => {
    await page.goto(ADSB_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(5000);

    const config = await page.evaluate(() => {
        // ColorByAlt - the altitude→color table
        const cba = window.ColorByAlt;

        // Trail timeout / density settings
        const settings = {
            tempTrailsTimeout:  window.tempTrailsTimeout,
            pTracksInterval:    window.pTracksInterval,
            pTracks:            window.pTracks,
            SelectedAllPlanes:  window.SelectedAllPlanes,
            showTrace:          window.showTrace,
            trackLabels:        window.trackLabels,
            labelZoom:          window.labelZoom,
            newWidth:           window.newWidth,
            monochromeTracks:   window.monochromeTracks,
            noVanish:           window.noVanish,
            positionFilter:     window.positionFilter,
            positionFilterSpeed: window.positionFilterSpeed,
            stale_timeout:      window.stale_timeout,
        };

        return {
            colorByAlt: cba ? JSON.stringify(cba).slice(0, 600) : 'not found',
            settings,
            defaultConfig: window.defaultConfig ? JSON.stringify(window.defaultConfig).slice(0,400) : null,
            userSettings:  window.userSettings  ? JSON.stringify(window.userSettings).slice(0,400)  : null,
        };
    });

    console.log('\n=== TRAIL SETTINGS ===');
    console.log('ColorByAlt:', config.colorByAlt);
    console.log('\nSettings:', JSON.stringify(config.settings, null, 2));
    if (config.defaultConfig) console.log('\ndefaultConfig:', config.defaultConfig);
    if (config.userSettings)  console.log('\nuserSettings:', config.userSettings);

    await shot(page, '04_config_state');
});

// ─── Test 4: Observe live data update & trail build ───────────────────────────
test('globe.adsb.fi — live update cycle and trail accumulation', async ({ page }) => {
    const apiCalls = [];
    page.on('request', req => {
        const u = req.url();
        if (u.includes('globe.adsb') || u.includes('/data/') || u.includes('aircraft')) {
            apiCalls.push(u.replace('https://globe.adsb.fi',''));
        }
    });

    await page.goto(ADSB_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(3000);

    // Select an aircraft
    const mapSel = page.locator('.ol-viewport').first();
    const box = await mapSel.boundingBox().catch(() => null);
    let icao = '';
    if (box) {
        for (const [rx,ry] of [[0.5,0.5],[0.4,0.4],[0.6,0.4],[0.5,0.3]]) {
            await page.mouse.click(box.x + box.width*rx, box.y + box.height*ry);
            await page.waitForTimeout(1200);
            const cs = await page.locator('#selected_callsign').textContent().catch(() => '');
            const icaoEl = await page.locator('#selected_icao').textContent().catch(() => '');
            if (cs?.trim()) { icao = icaoEl?.trim(); console.log(`✈️  Selected: ${cs.trim()} (${icao})`); break; }
        }
    }

    await shot(page, '05_before_update');

    // Wait for 2 update cycles (globe.adsb.fi updates ~every 1-2s)
    const segsBefore = await page.evaluate(() => window.selected_aircraft?.track_linesegs?.length ?? 0);
    console.log('\nSegments BEFORE wait:', segsBefore);

    await page.waitForTimeout(6000);
    await shot(page, '06_after_update');

    const segsAfter = await page.evaluate(() => {
        const a = window.selected_aircraft;
        if (!a) return { error: 'no selection' };
        return {
            segCount: a.track_linesegs?.length,
            traceLen: a.trace?.length,
            histSize: a.history_size,
            lastSeg:  a.track_linesegs?.at(-1) ? {
                coordCount: a.track_linesegs.at(-1).fixed?.getCoordinates?.()?.length,
                ts:         a.track_linesegs.at(-1).ts,
                estimated:  a.track_linesegs.at(-1).estimated,
            } : null,
        };
    });
    console.log('State AFTER 6s:', JSON.stringify(segsAfter, null, 2));

    // Summarize API calls
    const unique = [...new Set(apiCalls)];
    console.log('\n=== API CALLS IN SESSION ===');
    unique.slice(0, 30).forEach(u => console.log(' ', u));
});

// ─── Test 5: Sidebar data completeness ────────────────────────────────────────
test('globe.adsb.fi — sidebar field completeness vs AEROSTRAT', async ({ page }) => {
    await page.goto(ADSB_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(5000);

    // Select aircraft
    const mapSel = page.locator('.ol-viewport').first();
    const box = await mapSel.boundingBox().catch(() => null);
    if (box) {
        for (const [rx,ry] of [[0.5,0.5],[0.4,0.4],[0.6,0.4],[0.4,0.6],[0.6,0.6]]) {
            await page.mouse.click(box.x + box.width*rx, box.y + box.height*ry);
            await page.waitForTimeout(1200);
            const cs = await page.locator('#selected_callsign').textContent().catch(() => '');
            if (cs?.trim()) { console.log('Selected:', cs.trim()); break; }
        }
    }

    await page.waitForTimeout(2000);
    await shot(page, '07_sidebar');

    // Collect all visible sidebar values
    const sidebar = await page.evaluate(() => {
        const data = {};
        document.querySelectorAll('[id^="selected_"]').forEach(el => {
            const text = (el.textContent || '').trim();
            if (text && text.length > 0 && text.length < 300 && !text.includes('data:image')) {
                data[el.id] = text;
            }
        });
        return data;
    });

    console.log('\n=== SIDEBAR FIELDS (globe.adsb.fi) ===');
    Object.entries(sidebar).forEach(([k,v]) => console.log(`  ${k.padEnd(35)}: ${v}`));

    // Click History button
    const hist = page.locator('#show_trace');
    if (await hist.isVisible().catch(() => false)) {
        console.log('\n📜 Clicking History...');
        await hist.click();
        await page.waitForTimeout(4000);
        await shot(page, '08_with_history');

        const histState = await page.evaluate(() => {
            const a = window.selected_aircraft;
            return {
                fullTrace:   a?.fullTrace?.length ?? 0,
                recentTrace: a?.recentTrace?.length ?? 0,
                segCount:    a?.track_linesegs?.length ?? 0,
                showTrace:   window.showTrace,
            };
        });
        console.log('\nAfter History click:', JSON.stringify(histState, null, 2));
    }

    await shot(page, '09_final');
});
