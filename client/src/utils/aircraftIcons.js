/**
 * AIRCRAFT ICONS ENGINE V2
 * 
 * 包含 9 種機型 SVG 路徑、機型對應表、以及高度顯色邏輯。
 * 單位說明：高度（altitude）為公尺 (m)。
 */

// 核心 SVG 路徑庫 (軍火庫字典)
export const AIRCRAFT_SVGS = {
    // ==========================================
    // 🎯 第一層防線：高精度專屬機型 (Exact Matches)
    // ==========================================
    // 請指揮官將 AircraftShapesSVG 的 path d="..." 貼在此處
    A388: '',
    B77W: '',
    A320: '',
    C130: '',
    
    // ==========================================
    // 🛡️ 第二層防線：通用分類構型 (Fallback Categories)
    // ==========================================
    NARROW: 'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z',
    WIDE: 'M23.5 16v-2l-10.5-6V3.5c0-1.1-.9-2-2-2s-2 .9-2 2V8L-1.5 14v2l10.5-3V20l-3 2v2l5-1.5 5 1.5v-2l-3-2v-7l10.5 3z',
    JUMBO: 'M24.5 16v-2l-11.5-6.5V3c0-1.38-1.12-2.5-2.5-2.5S8 1.62 8 3v5.5L-3.5 15v2l11.5-3.5V21l-4 2.5v2L10.5 24l5.5 1.5v-2L12 21v-7.5L23.5 17v-1z',
    LIGHT: 'M12,2 L12,8 L19,12 L19,14 L12,13 L12,18 L15,20 L15,22 L12,21 L9,22 L9,20 L12,18 L12,13 L5,14 L5,12 L12,8 L12,2 Z',
    HELI: 'M13,2 C13,1.45 12.55,1 12,1 C11.45,1 11,1.45 11,2 L11,4 L5,4 C4.45,4 4,4.45 4,5 C4,5.55 4.45,6 5,6 L11,6 L11,10 L7,10 L7,11 L11,11 L11,13 L10,13 L10,14 L11,14 L11,20 C11,21.65 12.35,23 14,23 L14,21 C13.45,21 13,20.55 13,20 L13,14 L14,14 L14,13 L13,13 L13,11 L17,11 L17,10 L13,10 L13,6 L19,6 C19.55,6 20,5.55 20,5 C20,4.45 19.55,4 19,4 L13,4 L13,2 Z'
};

/**
 * 輔助函式：顏色線性內插
 */
function lerpColor(c1, c2, factor) {
    const r1 = parseInt(c1.substring(1, 3), 16);
    const g1 = parseInt(c1.substring(3, 5), 16);
    const b1 = parseInt(c1.substring(5, 7), 16);

    const r2 = parseInt(c2.substring(1, 3), 16);
    const g2 = parseInt(c2.substring(3, 5), 16);
    const b2 = parseInt(c2.substring(5, 7), 16);

    const r = Math.round(r1 + (r2 - r1) * factor);
    const g = Math.round(g1 + (g2 - g1) * factor);
    const b = Math.round(b1 + (b2 - b1) * factor);

    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * 根據高度 (公尺) 取得漸層顏色
 */
export function getAltitudeColor(altMeters) {
    if (altMeters === null || altMeters === undefined || altMeters < 0) return '#888888';

    const points = [
        { alt: 0, color: '#ff0000' },
        { alt: 500, color: '#ff6600' },
        { alt: 2000, color: '#ffcc00' },
        { alt: 5000, color: '#00cc00' },
        { alt: 8000, color: '#00cccc' },
        { alt: 12000, color: '#8000ff' }
    ];

    if (altMeters <= points[0].alt) return points[0].color;
    if (altMeters >= points[points.length - 1].alt) return points[points.length - 1].color;

    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        if (altMeters >= p1.alt && altMeters <= p2.alt) {
            const factor = (altMeters - p1.alt) / (p2.alt - p1.alt);
            return lerpColor(p1.color, p2.color, factor);
        }
    }

    return '#888888';
}

/**
 * 建立 SVG Data URI (支援旋轉與縮放補償)
 */
function createSvgDataUri(svgPath, color, isLarge) {
    // 依據是否為大型機調整 viewBox 的大小以確保圖示不被裁切
    const viewBox = isLarge ? "0 0 32 32" : "0 0 24 24";
    // 如果傳入的 SVG d path 裡已經有完整 svg tag 就不再加 (給予擴充彈性)
    if (svgPath && svgPath.startsWith('<svg')) {
        // Simple string replace for custom color injected
        const styledSvg = svgPath.replace(/fill="[^"]*"/, `fill="${color}"`);
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(styledSvg)}`;
    }

    // 預設的 viewBox=0 0 24 24 的通用渲染器 (不包含旋轉，由 Canvas 負責)
    const svgString = `<svg width="24" height="24" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg"><path d="${svgPath}" fill="${color}" stroke="#000000" stroke-width="0.5" /></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
}

/**
 * [V5.0.0] 升級雷達分類器邏輯 (雙層匹配防禦網)
 */
export function getAircraftIconUrl(plane) {
    const cat = plane.category;
    const type = (plane.typecode || '').toUpperCase();
    
    // 繼承司令部要求的：高度漸變顯色邏輯
    const color = plane.onGround ? '#AAAAAA' : getAltitudeColor(plane.altitude);
    const heading = plane.heading || 0;

    // 判斷是否為大型機 (用於調整 viewBox 置中)
    const isLarge = /^(A38|B74|A34|IL9|A33|A35|B76|B77|B78|MD1|DC1)/.test(type);

    // 🎯 1. 最高優先級：精確狙擊 (字典內有完全符合的機型代碼)
    if (AIRCRAFT_SVGS[type] && AIRCRAFT_SVGS[type].trim() !== '') {
        return createSvgDataUri(AIRCRAFT_SVGS[type], color, isLarge);
    }

    // 🛡️ 2. 次級防禦：特殊構型 (直升機 / 輕型機)
    if (cat === 8) return createSvgDataUri(AIRCRAFT_SVGS.HELI, color, false);
    if (cat === 1 || cat === 2 || cat === 3 || cat === 4) return createSvgDataUri(AIRCRAFT_SVGS.LIGHT, color, false);

    // 🛡️ 3. 三級防禦：正則模糊比對 (通用客機體型)
    if (/^(A38|B74|A34|IL9)/.test(type)) return createSvgDataUri(AIRCRAFT_SVGS.JUMBO, color, true);
    if (/^(A33|A35|B76|B77|B78|MD1|DC1)/.test(type)) return createSvgDataUri(AIRCRAFT_SVGS.WIDE, color, true);
    if (/^(A31|A32|B73|E1|E7|CRJ|BCS)/.test(type)) return createSvgDataUri(AIRCRAFT_SVGS.NARROW, color, false);

    // ⚠️ 4. 預設防禦
    return createSvgDataUri(AIRCRAFT_SVGS.NARROW, color, false);
}
