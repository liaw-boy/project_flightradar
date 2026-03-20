/**
 * AIRCRAFT ICONS ENGINE V5 — FR24-Grade Rendering (Dynamic MongoDB)
 *
 * All 182 aircraft silhouettes are loaded from MongoDB via /api/aircraft-shapes
 * at app startup — zero static bundle cost. Shapes include wingspan-proportional
 * scale factors and category classification.
 *
 * Resolution order:
 *   1. _shapesMap (populated from MongoDB at startup via initAircraftShapes)
 *   2. FALLBACK_SVGS (generic silhouettes by body class)
 *   3. Category-based fallback (NARROW default)
 */

// Shapes loaded from MongoDB at runtime — the single source of truth
const _shapesMap = new Map();

/**
 * Initialize aircraft shapes from API response.
 * Called by App.jsx on startup with data from dataManager.getAircraftShapes().
 * Each shape: { typecode, viewBox, paths: [string], scale: number, category: string }
 */
export function initAircraftShapes(shapesArray) {
    if (!Array.isArray(shapesArray) || shapesArray.length === 0) return;
    shapesArray.forEach(s => {
        const key = (s.typecode || '').toUpperCase().replace(/\s+/g, '_');
        _shapesMap.set(key, s);
    });
    console.log(`[AircraftIcons] Loaded ${_shapesMap.size} shapes from MongoDB.`);
}

// ── FR24 Color System ────────────────────────────────────────────────────────

const ALT_GRADIENT = [
    { alt:     0, color: '#c8b416' },
    { alt:   500, color: '#e0c015' },
    { alt:  2000, color: '#F5C211' },
    { alt:  5000, color: '#e8a80e' },
    { alt:  8000, color: '#d4860a' },
    { alt: 10000, color: '#b86a08' },
    { alt: 12000, color: '#8B5CF6' },
];

function lerpColor(c1, c2, t) {
    const r1 = parseInt(c1.slice(1, 3), 16), g1 = parseInt(c1.slice(3, 5), 16), b1 = parseInt(c1.slice(5, 7), 16);
    const r2 = parseInt(c2.slice(1, 3), 16), g2 = parseInt(c2.slice(3, 5), 16), b2 = parseInt(c2.slice(5, 7), 16);
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export function getAltitudeColor(altMeters) {
    if (altMeters == null || altMeters < 0) return '#888888';
    if (altMeters <= ALT_GRADIENT[0].alt) return ALT_GRADIENT[0].color;
    if (altMeters >= ALT_GRADIENT[ALT_GRADIENT.length - 1].alt) return ALT_GRADIENT[ALT_GRADIENT.length - 1].color;
    for (let i = 0; i < ALT_GRADIENT.length - 1; i++) {
        const p1 = ALT_GRADIENT[i], p2 = ALT_GRADIENT[i + 1];
        if (altMeters >= p1.alt && altMeters <= p2.alt) {
            return lerpColor(p1.color, p2.color, (altMeters - p1.alt) / (p2.alt - p1.alt));
        }
    }
    return '#888888';
}

// ── Fallback SVG Paths (viewBox 0 0 24 24) ──────────────────────────────────

const FALLBACK_SVGS = {
    NARROW:       'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z',
    WIDE:         'M23.5 16v-2l-10.5-6V3.5c0-1.1-.9-2-2-2s-2 .9-2 2V8L-1.5 14v2l10.5-3V20l-3 2v2l5-1.5 5 1.5v-2l-3-2v-7l10.5 3z',
    JUMBO:        'M24.5 16v-2l-11.5-6.5V3c0-1.38-1.12-2.5-2.5-2.5S8 1.62 8 3v5.5L-3.5 15v2l11.5-3.5V21l-4 2.5v2L10.5 24l5.5 1.5v-2L12 21v-7.5L23.5 17v-1z',
    TURBOPROP:    'M21 15v-2l-8-1V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V12l-8 1v2l8-1V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5l8 1z', // 高單翼 + 雙旋轉槳感
    PRIVATE_JET:  'M19 14v-2l-7-3V3.5C12 2.67 11.33 2 10.5 2S9 2.67 9 3.5V9l-7 3v2l7-2V19l-1 1V22l2.5-1.5 2.5 1.5v-3l-1-1v-7l7 2z', // 細長機身 + 尾部引擎感
    LIGHT:        'M12,2 L12,8 L19,12 L19,14 L12,13 L12,18 L15,20 L15,22 L12,21 L9,22 L9,20 L12,18 L12,13 L5,14 L5,12 L12,8 L12,2 Z',
    HELI:         'M13,2 C13,1.45 12.55,1 12,1 C11.45,1 11,1.45 11,2 L11,4 L5,4 C4.45,4 4,4.45 4,5 C4,5.55 4.45,6 5,6 L11,6 L11,10 L7,10 L7,11 L11,11 L11,13 L10,13 L10,14 L11,14 L11,20 C11,21.65 12.35,23 14,23 L14,21 C13.45,21 13,20.55 13,20 L13,14 L14,14 L14,13 L13,13 L13,11 L17,11 L17,10 L13,10 L13,6 L19,6 C19.55,6 20,5.55 20,5 C20,4.45 19.55,4 19,4 L13,4 L13,2 Z',
};

// ── SVG Data URI Construction ────────────────────────────────────────────────

function createSvgFromShape(shape, color) {
    const { viewBox, paths } = shape;
    const [outline, ...accents] = paths;

    const pathEls = [
        `<path d="${outline}" fill="${color}" stroke="rgba(0,0,0,0.5)" stroke-width="0.5"/>`,
        ...accents.map(d =>
            `<path d="${d}" fill="rgba(0,0,0,0.15)" stroke="rgba(0,0,0,0.3)" stroke-width="0.25"/>`
        ),
    ].join('');

    const svg = `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">${pathEls}</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createSvgFromFallback(pathD, color, vb) {
    const svg = `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg"><path d="${pathD}" fill="${color}" stroke="rgba(0,0,0,0.5)" stroke-width="0.5"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ── Key Normalization ────────────────────────────────────────────────────────

function normalizeKey(typecode) {
    return typecode.toUpperCase().replace(/\s+/g, '_');
}

// ── Size Classification (for fallback when shapes not loaded yet) ────────────

function classifyFallback(type, cat) {
    if (cat === 8) return { path: FALLBACK_SVGS.HELI, vb: '0 0 24 24', scale: 0.477 };
    
    // 輕型螺旋槳 (Cessna 172, etc.)
    if (cat === 1 || /^(C172|C182|P28A|C152|SR22|C208)/.test(type))
        return { path: FALLBACK_SVGS.LIGHT, vb: '0 0 24 24', scale: 0.4 };

    // 渦槳客機 (ATR 72, Dash 8, etc.)
    if (/^(AT7|AT4|DH8|SF3|F50|AN2|JS3|B190|BE20)/.test(type))
        return { path: FALLBACK_SVGS.TURBOPROP, vb: '0 0 24 24', scale: 0.85 };

    // 商務噴射機 (Gulfstream, Challenger, etc.)
    if (/^(GLF|CL3|CL6|FA7|E55P|C25B|C560|LJ)/.test(type))
        return { path: FALLBACK_SVGS.PRIVATE_JET, vb: '0 0 24 24', scale: 0.7 };

    // 巨型機 (A380, B747, A340, etc.)
    if (/^(A38|B74|A34|IL9|A22|A12|BLCF|SGUP)/.test(type))
        return { path: FALLBACK_SVGS.JUMBO, vb: '-4 0 32 28', scale: 1.8 };

    // 寬體機 (A350, B787, A330, B777, etc.)
    if (/^(A3[3-5]|B7[6-8]|MD1|DC1|IL7|C5M|C17[^2])/.test(type))
        return { path: FALLBACK_SVGS.WIDE, vb: '-2 0 28 26', scale: 1.4 };

    // 窄體機 (A320, B737, etc.)
    if (/^(A3[12]|A[12][0-9]N|B7[0-5]|B3[89]M|BCS|E1|CRJ|RJ|SU9|T20)/.test(type))
        return { path: FALLBACK_SVGS.NARROW, vb: '0 0 24 24', scale: 1.0 };

    return { path: FALLBACK_SVGS.NARROW, vb: '0 0 24 24', scale: 0.85 };
}

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Get the proportional scale factor for an aircraft (B738 = 1.0).
 */
export function getAircraftScale(plane) {
    const type = normalizeKey(plane.typecode || '');
    const shape = _shapesMap.get(type);
    if (shape) return Math.max(shape.scale || 1.0, 0.4);

    const fb = classifyFallback(type, plane.category);
    return fb.scale;
}

// --- High-Fidelity SVG Cache (Project AERO-SYNC) ---
const hdSvgCache = new Map();     // typecode -> raw SVG text
const hdSvgFailed = new Set();    // typecodes that 404'd
const hdSvgFetching = new Set();  // typecodes currently downloading

/**
 * Return SVG data URI for a given plane.
 * Sync, suitable for Image() or createImageBitmap().
 */
export function getAircraftIconUrl(plane) {
    const type = normalizeKey(plane.typecode || '');
    const color = plane.onGround ? '#AAAAAA' : getAltitudeColor(plane.altitude);

    // [v7.0] Try High-Fidelity SVG first (from public/shapes)
    // We only try if type exists, and it hasn't permanently failed before
    if (type && !hdSvgFailed.has(type)) {
        if (hdSvgCache.has(type)) {
            // We have the raw SVG text! Colorize it synchronously using a <style> block injection
            const rawSvg = hdSvgCache.get(type);
            const styledSvg = rawSvg.replace(
                /<svg([^>]*)>/i, 
                `<svg$1><style>path{fill:${color}!important; stroke:rgba(0,0,0,0.5)!important; stroke-width:0.3px!important;}</style>`
            );
            return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(styledSvg)}`;
        }

        // We don't have it yet, and haven't failed. Start fetch if not already fetching.
        if (!hdSvgFetching.has(type)) {
            hdSvgFetching.add(type);
            fetch(`/shapes/${type}.svg`)
                .then(res => {
                    if (!res.ok) throw new Error('Not found');
                    return res.text();
                })
                .then(text => {
                    hdSvgCache.set(type, text);
                    hdSvgFetching.delete(type);
                })
                .catch(() => {
                    hdSvgFailed.add(type);
                    hdSvgFetching.delete(type);
                });
        }
        
        // While fetching, simply fall through to the fallback icons below to prevent Canvas flickering
    }

    // 1. MongoDB shapes (loaded at startup)
    const shape = _shapesMap.get(type);
    if (shape) {
        return createSvgFromShape(shape, color);
    }

    // 2. Fallback by body class
    const fb = classifyFallback(type, plane.category);
    return createSvgFromFallback(fb.path, color, fb.vb);
}
