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
    NARROW: 'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z',
    WIDE:   'M23.5 16v-2l-10.5-6V3.5c0-1.1-.9-2-2-2s-2 .9-2 2V8L-1.5 14v2l10.5-3V20l-3 2v2l5-1.5 5 1.5v-2l-3-2v-7l10.5 3z',
    JUMBO:  'M24.5 16v-2l-11.5-6.5V3c0-1.38-1.12-2.5-2.5-2.5S8 1.62 8 3v5.5L-3.5 15v2l11.5-3.5V21l-4 2.5v2L10.5 24l5.5 1.5v-2L12 21v-7.5L23.5 17v-1z',
    LIGHT:  'M12,2 L12,8 L19,12 L19,14 L12,13 L12,18 L15,20 L15,22 L12,21 L9,22 L9,20 L12,18 L12,13 L5,14 L5,12 L12,8 L12,2 Z',
    HELI:   'M13,2 C13,1.45 12.55,1 12,1 C11.45,1 11,1.45 11,2 L11,4 L5,4 C4.45,4 4,4.45 4,5 C4,5.55 4.45,6 5,6 L11,6 L11,10 L7,10 L7,11 L11,11 L11,13 L10,13 L10,14 L11,14 L11,20 C11,21.65 12.35,23 14,23 L14,21 C13.45,21 13,20.55 13,20 L13,14 L14,14 L14,13 L13,13 L13,11 L17,11 L17,10 L13,10 L13,6 L19,6 C19.55,6 20,5.55 20,5 C20,4.45 19.55,4 19,4 L13,4 L13,2 Z',
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
    if (cat >= 1 && cat <= 4) return { path: FALLBACK_SVGS.LIGHT, vb: '0 0 24 24', scale: 0.35 };
    if (/^(A38|B74|A34|IL9|A22|A12|BLCF|SGUP)/.test(type)) return { path: FALLBACK_SVGS.JUMBO, vb: '-4 0 32 28', scale: 1.9 };
    if (/^(A3[3-5]|B7[6-8]|MD1|DC1|IL7|C5M|C17[^2])/.test(type)) return { path: FALLBACK_SVGS.WIDE, vb: '-2 0 28 26', scale: 1.5 };
    if (/^(A3[12]|A[12][0-9]N|B7[0-5]|B3[89]M|BCS|E1|CRJ|RJ|SU9|T20)/.test(type)) return { path: FALLBACK_SVGS.NARROW, vb: '0 0 24 24', scale: 1.0 };
    return { path: FALLBACK_SVGS.NARROW, vb: '0 0 24 24', scale: 0.8 };
}

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Get the proportional scale factor for an aircraft (B738 = 1.0).
 */
export function getAircraftScale(plane) {
    const type = normalizeKey(plane.typecode || '');
    const shape = _shapesMap.get(type);
    if (shape) return shape.scale || 1.0;

    const fb = classifyFallback(type, plane.category);
    return fb.scale;
}

/**
 * Return SVG data URI for a given plane.
 * Sync, suitable for Image() or createImageBitmap().
 */
export function getAircraftIconUrl(plane) {
    const type = normalizeKey(plane.typecode || '');
    const color = plane.onGround ? '#AAAAAA' : getAltitudeColor(plane.altitude);

    // 1. MongoDB shapes (loaded at startup)
    const shape = _shapesMap.get(type);
    if (shape) {
        return createSvgFromShape(shape, color);
    }

    // 2. Fallback by body class
    const fb = classifyFallback(type, plane.category);
    return createSvgFromFallback(fb.path, color, fb.vb);
}
