/**
 * AIRCRAFT ICONS ENGINE V3
 *
 * 三層圖示解析：
 *   1. _shapesMap (MongoDB) — 精確機型輪廓 (來自 AircraftShapesSVG GPLv3)
 *   2. FALLBACK_SVGS        — 手動嵌入的 path 字典 (備用)
 *   3. 體型分類 fallback     — NARROW / WIDE / JUMBO / LIGHT / HELI
 *
 * 高度著色：地面灰 → 地面紅 → 紫 (12000m+)
 * 初始化：App 啟動時呼叫 initAircraftShapes(shapesArray) 注入 MongoDB 資料。
 */

// 模組級別快取，由 initAircraftShapes() 填充
const _shapesMap = new Map();

/**
 * 將從 MongoDB /api/aircraft-shapes 取得的形狀陣列注入快取。
 * 由 App.jsx 在啟動時呼叫一次。
 */
export function initAircraftShapes(shapesArray) {
    if (!Array.isArray(shapesArray) || shapesArray.length === 0) return;
    shapesArray.forEach(s => _shapesMap.set(s.typecode, s));
    console.log(`✈  [AircraftIcons] Loaded ${_shapesMap.size} shapes from MongoDB.`);
}

// ── 體型分類 fallback paths (viewBox 0 0 24 24) ───────────────────────────────
const FALLBACK_SVGS = {
    NARROW: 'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z',
    WIDE:   'M23.5 16v-2l-10.5-6V3.5c0-1.1-.9-2-2-2s-2 .9-2 2V8L-1.5 14v2l10.5-3V20l-3 2v2l5-1.5 5 1.5v-2l-3-2v-7l10.5 3z',
    JUMBO:  'M24.5 16v-2l-11.5-6.5V3c0-1.38-1.12-2.5-2.5-2.5S8 1.62 8 3v5.5L-3.5 15v2l11.5-3.5V21l-4 2.5v2L10.5 24l5.5 1.5v-2L12 21v-7.5L23.5 17v-1z',
    LIGHT:  'M12,2 L12,8 L19,12 L19,14 L12,13 L12,18 L15,20 L15,22 L12,21 L9,22 L9,20 L12,18 L12,13 L5,14 L5,12 L12,8 L12,2 Z',
    HELI:   'M13,2 C13,1.45 12.55,1 12,1 C11.45,1 11,1.45 11,2 L11,4 L5,4 C4.45,4 4,4.45 4,5 C4,5.55 4.45,6 5,6 L11,6 L11,10 L7,10 L7,11 L11,11 L11,13 L10,13 L10,14 L11,14 L11,20 C11,21.65 12.35,23 14,23 L14,21 C13.45,21 13,20.55 13,20 L13,14 L14,14 L14,13 L13,13 L13,11 L17,11 L17,10 L13,10 L13,6 L19,6 C19.55,6 20,5.55 20,5 C20,4.45 19.55,4 19,4 L13,4 L13,2 Z',
};

// ── 高度著色 ──────────────────────────────────────────────────────────────────

function lerpColor(c1, c2, t) {
    const r1 = parseInt(c1.slice(1, 3), 16), g1 = parseInt(c1.slice(3, 5), 16), b1 = parseInt(c1.slice(5, 7), 16);
    const r2 = parseInt(c2.slice(1, 3), 16), g2 = parseInt(c2.slice(3, 5), 16), b2 = parseInt(c2.slice(5, 7), 16);
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

const ALT_GRADIENT = [
    { alt:     0, color: '#ff0000' },
    { alt:   500, color: '#ff6600' },
    { alt:  2000, color: '#ffcc00' },
    { alt:  5000, color: '#00cc00' },
    { alt:  8000, color: '#00cccc' },
    { alt: 12000, color: '#8000ff' },
];

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

// ── SVG Data URI 建構 ─────────────────────────────────────────────────────────

/**
 * 從 AIRCRAFT_SHAPES 生成 Data URI。
 * 第一個 path = 機身輪廓 (填色)；後續 paths = 細節 accent (半透明深色)。
 */
function createSvgFromShape(shape, color) {
    const { viewBox, paths } = shape;
    const [outline, ...accents] = paths;

    const pathEls = [
        `<path d="${outline}" fill="${color}" stroke="rgba(0,0,0,0.35)" stroke-width="0.4"/>`,
        ...accents.map(d => `<path d="${d}" fill="rgba(0,0,0,0.18)" stroke="rgba(0,0,0,0.25)" stroke-width="0.3"/>`),
    ].join('');

    const svg = `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">${pathEls}</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * 從 FALLBACK_SVGS 生成 Data URI (維持舊有 24x24 viewBox 格式)。
 */
function createSvgFromFallback(pathD, color, isLarge) {
    const viewBox = isLarge ? '0 0 32 32' : '0 0 24 24';
    const svg = `<svg width="24" height="24" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg"><path d="${pathD}" fill="${color}" stroke="#000000" stroke-width="0.5"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ── 機型 key 正規化 ──────────────────────────────────────────────────────────
// AircraftShapesSVG 把有空格的名稱轉成底線 (e.g. "B1 fast" → "B1_FAST")

function normalizeKey(typecode) {
    return typecode.toUpperCase().replace(/\s+/g, '_');
}

// ── 主要 API ──────────────────────────────────────────────────────────────────

/**
 * 根據飛機資料回傳 SVG Data URI (同步，供 Canvas createImageBitmap 使用)。
 */
export function getAircraftIconUrl(plane) {
    const cat  = plane.category;
    const type = normalizeKey(plane.typecode || '');
    const color = plane.onGround ? '#AAAAAA' : getAltitudeColor(plane.altitude);
    const isLarge = /^(A38|B74|A34|IL9|A33|A35|B76|B77|B78|MD1|DC1)/.test(type);

    // 1. 精確匹配 — _shapesMap (MongoDB, 216+ 機型)
    const shape = _shapesMap.get(type);
    if (shape) {
        return createSvgFromShape(shape, color);
    }

    // 2. 特殊構型 — 直升機 / 輕型機
    if (cat === 8) return createSvgFromFallback(FALLBACK_SVGS.HELI, color, false);
    if (cat >= 1 && cat <= 4) return createSvgFromFallback(FALLBACK_SVGS.LIGHT, color, false);

    // 3. 正則體型分類 — 寬體 / 窄體 / 超大型
    if (/^(A38|B74|A34|IL9)/.test(type)) return createSvgFromFallback(FALLBACK_SVGS.JUMBO,  color, true);
    if (/^(A33|A35|B76|B77|B78|MD1|DC1)/.test(type)) return createSvgFromFallback(FALLBACK_SVGS.WIDE, color, true);
    if (/^(A31|A32|B73|E1|E7|CRJ|BCS)/.test(type))   return createSvgFromFallback(FALLBACK_SVGS.NARROW, color, false);

    // 4. 預設
    return createSvgFromFallback(FALLBACK_SVGS.NARROW, color, isLarge);
}
