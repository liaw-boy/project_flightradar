// @ts-check
/**
 * PlaneFinder.net Deep Analysis
 * Analyzes: aircraft icon display, trail rendering, data processing
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const URL = 'https://planefinder.net/';
const OUT = path.resolve('..', 'pw-screenshots', 'planefinder');

function dir() { if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true }); }
async function shot(page, name) {
    dir();
    const p = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: p, fullPage: false });
    console.log(`📸 ${name}`);
}

// ─── Test 1: Page structure & rendering tech ──────────────────────────────────
test('planefinder — rendering tech, canvas/SVG structure', async ({ page }) => {
    const jsLoaded = [];
    page.on('response', r => {
        const u = r.url(), ct = r.headers()['content-type'] || '';
        if (ct.includes('javascript') && u.includes('planefinder')) jsLoaded.push(u.split('/').pop().split('?')[0]);
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(6000);
    await shot(page, '01_initial');

    const tech = await page.evaluate(() => {
        const r = {};
        // Rendering libs
        r.hasLeaflet    = typeof window.L !== 'undefined';
        r.hasOL         = typeof window.ol !== 'undefined';
        r.hasMapboxGL   = typeof window.mapboxgl !== 'undefined';
        r.hasThreeJS    = typeof window.THREE !== 'undefined';
        r.leafletVer    = window.L?.version || null;

        // Canvas/SVG inventory
        const canvases = [...document.querySelectorAll('canvas')];
        r.canvasCount   = canvases.length;
        r.canvasList    = canvases.map((c, i) => ({
            i, w: c.width, h: c.height,
            cls: c.className, id: c.id || '-',
            style: (c.getAttribute('style') || '').slice(0, 80)
        }));
        const svgs = [...document.querySelectorAll('svg')];
        r.svgCount = svgs.length;
        r.svgInfo  = svgs.slice(0, 5).map(s => ({ cls: s.className?.baseVal || s.className, w: s.getAttribute('width'), h: s.getAttribute('height') }));

        // WebGL detection
        const testCanvas = document.createElement('canvas');
        r.hasWebGL = !!(testCanvas.getContext('webgl') || testCanvas.getContext('webgl2'));

        // Key globals
        const globals = {};
        ['PF', 'pf', 'map', 'mapbox', 'flightMap', 'aircraft', 'planes',
         'trail', 'track', 'history', 'AircraftCollection', 'PlaneCollection',
         'selectedAircraft', 'socket', 'io'].forEach(k => {
            if (window[k] !== undefined) {
                const v = window[k];
                globals[k] = typeof v === 'function' ? `[Function]`
                    : typeof v === 'object' ? JSON.stringify(v).slice(0,120)
                    : String(v).slice(0, 100);
            }
        });
        r.globals = globals;

        // Leaflet layers if present
        if (window.L && window.map) {
            try {
                r.leafletLayers = [];
                window.map.eachLayer(l => r.leafletLayers.push(l.constructor?.name || 'Layer'));
            } catch(e) {}
        }

        // Map container class names for clues
        r.mapContainerClasses = [...document.querySelectorAll('[class*="map"], [id*="map"]')]
            .slice(0, 8).map(el => `${el.tagName}#${el.id}.${el.className}`.slice(0, 80));

        return r;
    });

    console.log('\n=== RENDERING TECHNOLOGY ===');
    console.log('Leaflet:', tech.hasLeaflet, tech.leafletVer || '');
    console.log('OpenLayers:', tech.hasOL);
    console.log('MapboxGL:', tech.hasMapboxGL);
    console.log('WebGL:', tech.hasWebGL);
    console.log('Canvas count:', tech.canvasCount);
    tech.canvasList.forEach(c => console.log(`  [${c.i}] ${c.w}x${c.h} cls="${c.cls}" id="${c.id}"`));
    console.log('SVG count:', tech.svgCount);
    tech.svgInfo.forEach(s => console.log(`  SVG cls="${s.cls}" ${s.w}x${s.h}`));
    console.log('\nMap containers:');
    tech.mapContainerClasses.forEach(m => console.log(' ', m));
    console.log('\nGlobals:', JSON.stringify(tech.globals, null, 2));
    if (tech.leafletLayers) console.log('Leaflet layers:', tech.leafletLayers);
    console.log('\nJS files:', jsLoaded.slice(0, 15));
});

// ─── Test 2: Aircraft icon analysis ─────────────────────────────────────────
test('planefinder — aircraft icon rendering method', async ({ page }) => {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(6000);

    const iconInfo = await page.evaluate(() => {
        const r = {};

        // Look for aircraft marker/icon elements in DOM
        const markerSelectors = [
            '.leaflet-marker-icon', '.aircraft-icon', '.plane-icon',
            '[class*="aircraft"]', '[class*="plane"]', '[class*="marker"]',
            '.leaflet-overlay-pane canvas', '.leaflet-icon'
        ];
        r.markers = {};
        markerSelectors.forEach(sel => {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
                const sample = els[0];
                r.markers[sel] = {
                    count: els.length,
                    tagName: sample.tagName,
                    className: sample.className,
                    style: sample.getAttribute('style')?.slice(0,100) || '',
                    src: sample.getAttribute('src') || '',
                    innerHTML: sample.innerHTML.slice(0, 200)
                };
            }
        });

        // Look for icon image sources (SVG data URIs, img src, CSS background)
        const imgs = [...document.querySelectorAll('img[src*="aircraft"], img[src*="plane"], img[src*="icon"]')];
        r.imgSrcs = imgs.slice(0,5).map(i => i.src.slice(0,100));

        // Check for canvas-based rendering (markers on canvas vs DOM)
        const overlayCanvas = document.querySelector('.leaflet-overlay-pane canvas');
        r.hasCanvasLayer = !!overlayCanvas;
        if (overlayCanvas) {
            r.canvasSize = `${overlayCanvas.width}x${overlayCanvas.height}`;
            const ctx = overlayCanvas.getContext('2d');
            if (ctx) {
                const data = ctx.getImageData(0, 0, Math.min(overlayCanvas.width, 300), Math.min(overlayCanvas.height, 300)).data;
                r.canvasHasContent = [...data].some(v => v > 0);
            }
        }

        // Check Leaflet marker pane
        const markerPane = document.querySelector('.leaflet-marker-pane');
        r.markerPaneChildCount = markerPane?.children.length || 0;
        r.markerPaneSample = markerPane?.children[0]?.outerHTML.slice(0,300) || '';

        // Check for custom DivIcon (HTML markers)
        const divIcons = document.querySelectorAll('.leaflet-marker-pane > div');
        r.divIconCount = divIcons.length;
        if (divIcons.length > 0) r.divIconSample = divIcons[0].outerHTML.slice(0,300);

        return r;
    });

    console.log('\n=== AIRCRAFT ICON ANALYSIS ===');
    console.log('Has canvas layer:', iconInfo.hasCanvasLayer, iconInfo.canvasSize || '');
    console.log('Canvas has content:', iconInfo.canvasHasContent);
    console.log('Marker pane children:', iconInfo.markerPaneChildCount);
    if (iconInfo.markerPaneSample) console.log('Marker sample:', iconInfo.markerPaneSample);
    console.log('DivIcon count:', iconInfo.divIconCount);
    if (iconInfo.divIconSample) console.log('DivIcon sample:', iconInfo.divIconSample.slice(0,200));
    Object.entries(iconInfo.markers).forEach(([sel, v]) => {
        console.log(`\n  Selector "${sel}": ${v.count} elements`);
        console.log(`    tagName: ${v.tagName}, class: ${v.className?.slice(0,60)}`);
        if (v.src) console.log(`    src: ${v.src}`);
        if (v.innerHTML) console.log(`    innerHTML: ${v.innerHTML.slice(0,150)}`);
    });

    await shot(page, '02_icons');
});

// ─── Test 3: Select aircraft and analyze trail ────────────────────────────────
test('planefinder — aircraft selection and trail rendering', async ({ page }) => {
    const apiCalls = [];
    page.on('request', req => {
        const u = req.url();
        if (u.includes('planefinder') || u.includes('/track') || u.includes('/trail') || u.includes('/history')) {
            apiCalls.push({ method: req.method(), url: u.replace('https://planefinder.net','').slice(0,100) });
        }
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(7000);
    await shot(page, '03_before_click');

    // Try to click on an aircraft
    const mapEl = page.locator('.leaflet-container, #map, [id*="map"], canvas').first();
    const box = await mapEl.boundingBox().catch(() => null);

    let selected = false;
    if (box) {
        const pts = [
            [0.5,0.5],[0.45,0.45],[0.55,0.45],[0.4,0.5],[0.6,0.5],
            [0.5,0.4],[0.5,0.6],[0.35,0.4],[0.65,0.4],[0.4,0.6],[0.6,0.6],
            [0.3,0.3],[0.7,0.3],[0.3,0.7],[0.7,0.7],
        ];
        for (const [rx,ry] of pts) {
            await page.mouse.click(box.x + box.width * rx, box.y + box.height * ry);
            await page.waitForTimeout(900);
            // PlaneFinder shows sidebar/panel on selection
            const panelVisible = await page.locator(
                '[class*="sidebar"], [class*="detail"], [class*="selected"], [class*="info-panel"], [id*="flight"]'
            ).first().isVisible().catch(() => false);
            const urlChanged = page.url().includes('flight') || page.url().includes('aircraft') || page.url().includes('hex') || page.url().includes('#');
            if (panelVisible || urlChanged) {
                selected = true;
                console.log(`✅ Selected at (${rx},${ry}) | URL: ${page.url().slice(0,80)}`);
                break;
            }
        }
    }

    await page.waitForTimeout(2000);
    await shot(page, '04_after_click');

    const trailInfo = await page.evaluate(() => {
        const r = {};

        // After selection, analyze DOM for trail elements
        const overlayCanvas = document.querySelector('.leaflet-overlay-pane canvas');
        if (overlayCanvas) {
            const ctx = overlayCanvas.getContext('2d');
            if (ctx) {
                const data = ctx.getImageData(0, 0, Math.min(overlayCanvas.width,400), Math.min(overlayCanvas.height,400)).data;
                r.canvasHasContent = [...data].some(v => v > 0);
                // Count non-zero pixels (rough trail density)
                let nonZero = 0;
                for (let i = 3; i < data.length; i += 4) if (data[i] > 10) nonZero++;
                r.nonZeroPixels = nonZero;
            }
        }

        // SVG paths for trail (some implementations use SVG overlay)
        const svgPaths = [...document.querySelectorAll('.leaflet-overlay-pane path, .trail-path, [class*="trail"] path')];
        r.svgPathCount = svgPaths.length;
        if (svgPaths.length > 0) {
            r.svgPathSample = {
                stroke: svgPaths[0].getAttribute('stroke'),
                strokeWidth: svgPaths[0].getAttribute('stroke-width'),
                d: svgPaths[0].getAttribute('d')?.slice(0,100),
                className: svgPaths[0].className?.baseVal || svgPaths[0].className
            };
        }

        // Leaflet polyline elements
        const polylines = [...document.querySelectorAll('.leaflet-pane polyline, .leaflet-pane path')];
        r.polylineCount = polylines.length;
        if (polylines.length > 0) {
            r.polylineSample = polylines[0].outerHTML.slice(0, 300);
        }

        // Check for color gradient info
        r.selectedAircraftInfo = null;
        if (window.PF?.selectedFlight || window.selectedAircraft || window.map?._layers) {
            try {
                const sa = window.PF?.selectedFlight || window.selectedAircraft;
                if (sa) r.selectedAircraftInfo = JSON.stringify(sa).slice(0,300);
            } catch(e) {}
        }

        return r;
    });

    console.log(`\nAircraft selected: ${selected}`);
    console.log('=== TRAIL RENDERING INFO ===');
    console.log('Canvas non-zero pixels:', trailInfo.nonZeroPixels);
    console.log('SVG paths in overlay:', trailInfo.svgPathCount);
    if (trailInfo.svgPathSample) console.log('SVG path sample:', JSON.stringify(trailInfo.svgPathSample));
    console.log('Polyline count:', trailInfo.polylineCount);
    if (trailInfo.polylineSample) console.log('Polyline sample:', trailInfo.polylineSample.slice(0,200));
    if (trailInfo.selectedAircraftInfo) console.log('Selected aircraft:', trailInfo.selectedAircraftInfo);

    console.log('\n=== API CALLS ===');
    [...new Set(apiCalls.map(c => c.url))].forEach(u => console.log(' ', u));
});

// ─── Test 4: Trail color scheme & data structure ─────────────────────────────
test('planefinder — trail colors, data feed, websocket', async ({ page }) => {
    const wsCalls = [], httpCalls = [];

    page.on('websocket', ws => {
        wsCalls.push(ws.url());
        ws.on('framereceived', f => {
            if (typeof f.payload === 'string' && f.payload.length < 500) {
                console.log('[WS frame]', f.payload.slice(0,200));
            }
        });
    });

    page.on('response', async r => {
        const u = r.url();
        if (u.includes('planefinder') && !u.match(/\.(css|png|jpg|gif|woff|svg|ico)$/i)) {
            const ct = r.headers()['content-type'] || '';
            if (ct.includes('json') || ct.includes('javascript')) {
                httpCalls.push(u.replace('https://planefinder.net', '').slice(0, 100));
                if (ct.includes('json') && u.includes('/') && !u.includes('chunk')) {
                    try {
                        const body = await r.text();
                        if (body.length < 5000 && body.startsWith('{') || body.startsWith('[')) {
                            console.log(`[API] ${u.slice(-60)}: ${body.slice(0,300)}`);
                        }
                    } catch(e) {}
                }
            }
        }
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(8000);

    console.log('\n=== WEBSOCKET CONNECTIONS ===');
    wsCalls.forEach(u => console.log(' ', u));

    console.log('\n=== HTTP API CALLS ===');
    [...new Set(httpCalls)].forEach(u => console.log(' ', u));

    // Inspect CSS for trail/aircraft color rules
    const cssColors = await page.evaluate(() => {
        const rules = [];
        [...document.styleSheets].forEach(sheet => {
            try {
                [...sheet.cssRules || []].forEach(rule => {
                    const text = rule.cssText || '';
                    if (/trail|track|aircraft|plane|marker|selected/i.test(text) && /color|stroke|fill/i.test(text)) {
                        rules.push(text.slice(0, 200));
                    }
                });
            } catch(e) {}
        });
        return rules.slice(0, 20);
    });

    if (cssColors.length > 0) {
        console.log('\n=== TRAIL/AIRCRAFT CSS RULES ===');
        cssColors.forEach(r => console.log(' ', r));
    }

    // Deep inspect any aircraft data structure
    const dataStructure = await page.evaluate(() => {
        const r = {};

        // PlaneFinder uses PF global namespace
        if (window.PF) {
            r.PFkeys = Object.keys(window.PF).slice(0,30);
            if (window.PF.map) r.PFmapType = window.PF.map.constructor?.name;
            if (window.PF.aircraft) {
                r.PFaircraftType = typeof window.PF.aircraft;
                r.PFaircraftSample = JSON.stringify(window.PF.aircraft).slice(0,300);
            }
        }

        // Look for Leaflet map instance
        const mapEls = document.querySelectorAll('[class*="leaflet"]');
        r.leafletElCount = mapEls.length;

        // Check for any trail-related JavaScript objects
        const trailKeys = Object.keys(window).filter(k => /trail|track|history|replay/i.test(k));
        r.trailRelatedGlobals = trailKeys;

        // Check update interval/timer hints
        const timerHints = Object.keys(window).filter(k => /interval|timer|update|refresh|poll/i.test(k));
        r.timerGlobals = timerHints.slice(0,10);

        // Socket.io detection
        r.hasSocketIO = typeof window.io !== 'undefined';
        if (window.io) {
            r.socketIOVersion = window.io.version || 'present';
        }

        return r;
    });

    console.log('\n=== DATA STRUCTURE ===');
    console.log(JSON.stringify(dataStructure, null, 2));

    await shot(page, '05_data_state');
});

// ─── Test 5: Select aircraft for full trail + sidebar analysis ────────────────
test('planefinder — full trail + sidebar after selection', async ({ page }) => {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(8000);
    await shot(page, '06_map_loaded');

    // Try multiple areas
    const mapEl = page.locator('.leaflet-container, #map, [id*="map"]').first();
    const box = await mapEl.boundingBox().catch(() => null);

    let selectedText = '';
    if (box) {
        for (const [rx,ry] of [[0.5,0.5],[0.4,0.4],[0.6,0.4],[0.5,0.35],[0.35,0.5],[0.6,0.6],[0.3,0.4]]) {
            await page.mouse.click(box.x + box.width * rx, box.y + box.height * ry);
            await page.waitForTimeout(1200);
            // Capture any visible sidebar text
            const txt = await page.locator('body').innerText().catch(() => '');
            if (txt.includes('Flight') || txt.includes('Callsign') || txt.includes('ft') && txt.includes('kts')) {
                selectedText = txt.slice(0, 500);
                console.log('✅ Aircraft selected — sidebar visible');
                break;
            }
        }
    }

    await page.waitForTimeout(3000);
    await shot(page, '07_selected_trail');

    // Full DOM inspection after selection
    const fullInspect = await page.evaluate(() => {
        const r = {};

        // Trail SVG analysis
        const allPaths = [...document.querySelectorAll('svg path, polyline')];
        r.totalSvgPaths = allPaths.length;

        // Colored segments (altitude coloring)
        const coloredPaths = allPaths.filter(p => p.getAttribute('stroke') && p.getAttribute('stroke') !== 'none');
        r.coloredPaths = coloredPaths.length;
        r.colorSamples = coloredPaths.slice(0,8).map(p => ({
            stroke: p.getAttribute('stroke'),
            strokeWidth: p.getAttribute('stroke-width'),
            opacity: p.getAttribute('stroke-opacity'),
            cls: p.className?.baseVal || p.className
        }));

        // Canvas pixel analysis
        const canvases = [...document.querySelectorAll('canvas')];
        r.canvasAnalysis = canvases.map((c, i) => {
            let nonZero = 0, hasContent = false;
            try {
                const ctx = c.getContext('2d');
                if (ctx && c.width > 0 && c.height > 0) {
                    const d = ctx.getImageData(0, 0, Math.min(c.width,500), Math.min(c.height,500)).data;
                    for (let j = 3; j < d.length; j += 4) if (d[j] > 10) nonZero++;
                    hasContent = nonZero > 0;
                }
            } catch(e) {}
            return { i, size: `${c.width}x${c.height}`, nonZero, hasContent };
        });

        // Sidebar content
        const sidebar = document.querySelector('[class*="sidebar"], [class*="panel"], [class*="info"], [id*="flight-info"]');
        r.sidebarHTML = sidebar?.outerHTML.replace(/<img[^>]+>/g,'[IMG]').slice(0,600) || '';

        return r;
    });

    console.log('\n=== FULL INSPECTION AFTER SELECTION ===');
    console.log('Total SVG paths:', fullInspect.totalSvgPaths);
    console.log('Colored SVG paths (trail?):', fullInspect.coloredPaths);
    if (fullInspect.colorSamples.length > 0) {
        console.log('Color samples:');
        fullInspect.colorSamples.forEach(c => console.log(`  stroke=${c.stroke} w=${c.strokeWidth} op=${c.opacity} cls=${c.cls}`));
    }
    console.log('\nCanvas analysis:');
    fullInspect.canvasAnalysis.forEach(c => console.log(`  [${c.i}] ${c.size} nonZero=${c.nonZero} hasContent=${c.hasContent}`));
    if (fullInspect.sidebarHTML) console.log('\nSidebar:', fullInspect.sidebarHTML);

    await shot(page, '08_final');
});
