import { dataManager } from '../services/dataManager';

const EARTH_RADIUS = 6371000;

/**
 * [OPT 6.1] 將經度正規化至 -180 ~ 180 之間
 * 改用模算運算，防止 NaN/Infinity 造成無空迴圈
 */
export function normalizeLongitude(lng) {
    if (!isFinite(lng)) return 0;
    return ((lng + 180) % 360 + 360) % 360 - 180;
}

/**
 * Wrap a longitude to the world copy nearest to the current map center.
 * Enables infinite horizontal scrolling without a date-line jump.
 * e.g. centerLng=200, lng=150  → 150 (same copy)
 *      centerLng=200, lng=-170 → 190 (right-side world copy)
 */
export function wrapLngToMap(lng, centerLng) {
    if (!isFinite(lng) || !isFinite(centerLng)) return normalizeLongitude(lng);
    const norm = normalizeLongitude(lng);
    const offset = Math.round((centerLng - norm) / 360) * 360;
    return norm + offset;
}

// ==========================================
// 全球主要機場資料庫 (現在由伺服器動態提供)
// ==========================================
export const AIRPORTS = [];

/**
 * Populate the AIRPORTS array from the loaded airport list.
 * Called once after dataManager.getAirports() resolves.
 */
export function initAirportDatabase(airports) {
    if (!Array.isArray(airports) || airports.length === 0) return;
    AIRPORTS.length = 0;
    for (let i = 0; i < airports.length; i++) {
        const a = airports[i];
        // Support both {lat, lng} and {lat, lon} field names
        const lat = a.lat ?? a.latitude;
        const lng = a.lng ?? a.lon ?? a.longitude;
        if (lat != null && lng != null) {
            AIRPORTS.push({ ...a, lat, lng });
        }
    }
}

// ─── [DEP] 國際機場 IATA 與城市對照表 (現在已由 DataManager 統一管理) ────────
export const getAirportDisplayData = async (code) => {
    // 為了向下相容保留此函數，但邏輯轉發給 dataManager
    return dataManager.getAirport(code);
};

// ==========================================
// 航空公司資料庫
// ==========================================
const AIRLINE_DB = {
    // Taiwan
    'CAL': 'China Airlines 中華航空', 'EVA': 'EVA Air 長榮航空', 'MDA': 'Mandarin Airlines 華信航空',
    'UIA': 'Uni Air 立榮航空', 'TNA': 'TransAsia Airways 復興航空', 'TTW': 'Tigerair Taiwan 台灣虎航',
    'SJX': 'StarLux Airlines 星宇航空', 'FEA': 'Far Eastern Air Transport 遠東航空',
    // Japan
    'JAL': 'Japan Airlines 日本航空', 'ANA': 'All Nippon Airways 全日空', 'JJP': 'Jetstar Japan 日本捷星',
    'APJ': 'Peach Aviation 樂桃航空', 'SFJ': 'StarFlyer 星悅航空', 'ADO': 'Air Do 北海道航空',
    'SNJ': 'Solaseed Air 空之子航空',
    // Korea
    'KAL': 'Korean Air 大韓航空', 'AAR': 'Asiana Airlines 韓亞航空', 'JNA': 'Jin Air 真航空',
    'TWB': "T'way Air 德威航空", 'JJA': 'Jeju Air 濟州航空', 'ABL': 'Air Busan 釜山航空',
    'ESR': 'Eastar Jet 易斯達航空',
    // China
    'CCA': 'Air China 中國國際航空', 'CES': 'China Eastern 中國東方航空', 'CSN': 'China Southern 中國南方航空',
    'CRK': 'Hong Kong Airlines 香港航空', 'HXA': 'Hong Kong Airlines 香港航空',
    'CPA': 'Cathay Pacific 國泰航空', 'HDA': 'Cathay Dragon 國泰港龍', 'HKE': 'HK Express 香港快運',
    'SHQ': 'Spring Airlines 春秋航空', 'CSZ': 'Shenzhen Airlines 深圳航空', 'CDG': 'Shandong Airlines 山東航空',
    'CHH': 'Hainan Airlines 海南航空',
    // Southeast Asia
    'SIA': 'Singapore Airlines 新加坡航空', 'THA': 'Thai Airways 泰國航空', 'MAS': 'Malaysia Airlines 馬來西亞航空',
    'AXM': 'AirAsia 亞洲航空', 'GIA': 'Garuda Indonesia 印尼航空', 'PAL': 'Philippine Airlines 菲律賓航空',
    'CEB': 'Cebu Pacific 宿霧太平洋航空', 'VJC': 'Vietjet 越捷航空', 'HVN': 'Vietnam Airlines 越南航空',
    // Global Major
    'BAW': 'British Airways 英國航空', 'DLH': 'Lufthansa 漢莎航空', 'AFR': 'Air France 法國航空',
    'KLM': 'KLM 荷蘭皇家航空', 'UAE': 'Emirates 阿聯酋航空', 'QTR': 'Qatar Airways 卡達航空',
    'SWA': 'Southwest Airlines 西南航空', 'AAL': 'American Airlines 美國航空', 'DAL': 'Delta Air Lines 達美航空',
    'UAL': 'United Airlines 聯合航空', 'THY': 'Turkish Airlines 土耳其航空',
    // Cargo
    'FDX': 'FedEx Express', 'UPS': 'UPS Airlines', 'GTI': 'Atlas Air',
    'CLX': 'Cargolux', 'CKS': 'Kalitta Air', 'ABW': 'AirBridgeCargo',
    'AHK': 'Air Hong Kong', 'CAO': 'Air China Cargo', 'APZ': 'Air Premia',
};

// ==========================================
// 飛機類別名稱
// ==========================================
const CATEGORY_NAMES = {
    0: 'No Info', 1: 'No ADS-B', 2: 'Light',
    3: 'Small', 4: 'Large', 5: 'High Vortex Large',
    6: 'Heavy', 7: 'High Performance', 8: 'Rotorcraft',
    9: 'Glider', 10: 'Lighter-than-air', 11: 'Skydiver',
    12: 'Ultralight', 14: 'UAV', 15: 'Space Vehicle',
    17: 'Surface Emergency', 18: 'Surface Service', 19: 'Point Obstacle',
};

// ==========================================
// [OPT 3.1] 合併 AIRLINE_LOGOS 與 ICAO_TO_IATA 為單一來源
// ICAO 呼號前綴 -> IATA 代碼 對照表
// ==========================================
export const ICAO_TO_IATA = {
    // Taiwan
    'CAL': 'CI', 'EVA': 'BR', 'MDA': 'AE', 'UIA': 'B7', 'SJX': 'JX', 'TTW': 'IT', 'FEA': 'FE',
    // Japan
    'JAL': 'JL', 'ANA': 'NH', 'JJP': 'GK', 'APJ': 'MM', 'SFJ': '7G', 'ADO': 'HD', 'SNJ': '6J',
    // Korea
    'KAL': 'KE', 'AAR': 'OZ', 'JNA': 'LJ', 'TWB': 'TW', 'JJA': '7C', 'ABL': 'BX', 'ESR': 'ZE',
    // China
    'CCA': 'CA', 'CES': 'MU', 'CSN': 'CZ', 'HXA': 'HX', 'CPA': 'CX', 'HDA': 'KA', 'HKE': 'UO', 'SHQ': '9C',
    'CSZ': 'ZH', 'CDG': 'SC', 'CHH': 'HU',
    // Southeast Asia
    'SIA': 'SQ', 'THA': 'TG', 'MAS': 'MH', 'AXM': 'AK', 'GIA': 'GA', 'PAL': 'PR',
    'CEB': '5J', 'VJC': 'VJ', 'HVN': 'VN', 'JSA': '3K', 'SLK': 'MI', 'SCO': 'TR', 'TGW': 'TR',
    // Middle East
    'UAE': 'EK', 'ETD': 'EY', 'QTR': 'QR', 'THY': 'TK', 'SVA': 'SV', 'GFA': 'GF',
    // Europe
    'BAW': 'BA', 'DLH': 'LH', 'AFR': 'AF', 'KLM': 'KL', 'SAS': 'SK', 'FIN': 'AY',
    'SWR': 'LX', 'AUA': 'OS', 'TAP': 'TP', 'IBE': 'IB', 'AZA': 'AZ', 'LOT': 'LO',
    'EZY': 'U2', 'RYR': 'FR', 'WZZ': 'W6',
    // Americas
    'AAL': 'AA', 'DAL': 'DL', 'UAL': 'UA', 'SWA': 'WN', 'JBU': 'B6', 'ASA': 'AS',
    'ACA': 'AC', 'TAM': 'JJ', 'AVA': 'AV',
    // Oceania
    'QFA': 'QF', 'ANZ': 'NZ', 'JST': 'JQ', 'VOZ': 'VA',
    // Cargo
    'FDX': 'FX', 'UPS': '5X', 'GTI': '5Y', 'CLX': 'CV', 'CKS': 'K4', 'ABW': 'RU',
    'AHK': 'LD', 'CAO': 'CA',
};
// 向下相容別名
/** @deprecated Use ICAO_TO_IATA instead */
export const AIRLINE_LOGOS = ICAO_TO_IATA;

// ==========================================
// 國家旗幟 Emoji
// ==========================================
const COUNTRY_ISO = {
    'Taiwan': 'tw', 'Japan': 'jp', 'South Korea': 'kr', 'Republic of Korea': 'kr',
    'China': 'cn', 'Hong Kong': 'hk', 'Macau': 'mo',
    'Singapore': 'sg', 'Thailand': 'th', 'Malaysia': 'my', 'Philippines': 'ph',
    'Indonesia': 'id', 'Vietnam': 'vn', 'Cambodia': 'kh', 'Myanmar': 'mm',
    'India': 'in', 'Pakistan': 'pk', 'Bangladesh': 'bd', 'Sri Lanka': 'lk',
    'United States': 'us', 'Canada': 'ca', 'Mexico': 'mx', 'Brazil': 'br',
    'Argentina': 'ar', 'Chile': 'cl', 'Colombia': 'co',
    'United Kingdom': 'gb', 'France': 'fr', 'Germany': 'de', 'Italy': 'it',
    'Spain': 'es', 'Netherlands': 'nl', 'Switzerland': 'ch', 'Austria': 'at',
    'Sweden': 'se', 'Norway': 'no', 'Denmark': 'dk', 'Finland': 'fi',
    'Poland': 'pl', 'Portugal': 'pt', 'Ireland': 'ie', 'Belgium': 'be',
    'Greece': 'gr', 'Czechia': 'cz', 'Turkey': 'tr', 'Turkiye': 'tr',
    'Russia': 'ru', 'Ukraine': 'ua', 'Israel': 'il',
    'United Arab Emirates': 'ae', 'Saudi Arabia': 'sa', 'Qatar': 'qa',
    'Australia': 'au', 'New Zealand': 'nz',
    'South Africa': 'za', 'Egypt': 'eg', 'Ethiopia': 'et', 'Kenya': 'ke',
    'Morocco': 'ma', 'Nigeria': 'ng', 'Ghana': 'gh',
    'Jordan': 'jo', 'Kuwait': 'kw', 'Bahrain': 'bh', 'Oman': 'om',
    'Hungary': 'hu', 'Romania': 'ro', 'Bulgaria': 'bg', 'Croatia': 'hr',
    'Slovakia': 'sk', 'Slovenia': 'si', 'Serbia': 'rs',
    'Kazakhstan': 'kz', 'Uzbekistan': 'uz',
    'Nepal': 'np', 'Maldives': 'mv',
    'Peru': 'pe', 'Ecuador': 'ec', 'Bolivia': 'bo',
};

/**
 * 取得航空公司名稱
 */
export function getAirlineName(callsign) {
    if (!callsign || callsign === 'UNKNOWN') return '';

    // [Phase 10] 使用 Regex 提取前三個字母 (ICAO)
    const match = callsign.match(/^[A-Z]{3}/);
    if (!match) return '';

    const prefix = match[0];
    return AIRLINE_DB[prefix] || '';
}

/**
 * 取得類別名稱
 */
export function getCategoryName(cat) {
    return CATEGORY_NAMES[cat] || 'Unknown';
}

/**
 * 取得國旗 Emoji
 */
export function getCountryIso(country) {
    if (!country) return null;
    return COUNTRY_ISO[country] || null;
}

/**
 * 格式化當地時間 (支援時區)
 */
export function formatLocalTime(timestamp, timeZone) {
    if (!timestamp) return '--:--';
    try {
        const formatter = new Intl.DateTimeFormat([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: timeZone || undefined,
            timeZoneName: 'short'
        });
        return formatter.format(new Date(timestamp * 1000));
    } catch (e) {
        return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
}

function haversine(lat1, lng1, lat2, lng2) {
    const R = EARTH_RADIUS;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 計算最近機場
 */
export function getNearestAirport(lat, lng) {
    let nearest = null;
    let minDist = Infinity;
    for (let i = 0; i < AIRPORTS.length; i++) {
        const ap = AIRPORTS[i];
        const d = haversine(lat, lng, ap.lat, ap.lng);
        if (d < minDist) {
            minDist = d;
            nearest = ap;
        }
    }
    return nearest ? { airport: nearest, distance: Math.round(minDist) } : null;
}

// ── tar1090 / globe.adsb.fi altitude color system (HSL, altitudes in METRES) ──
// Warm colours at low altitude (takeoff/landing danger zone)
// → Cool green at typical cruise altitude (most time spent here)
// → Purple/red at extreme high altitude (unusual/special)
// This is the same gradient used by tar1090, globe.adsb.fi, and FR24.
// Converted from tar1090's feet-based stops to metres (1ft = 0.3048m).
const _ALT_STOPS = [
    { alt:     0, h:  20, s: 88, l: 52 }, // orange       — ground / takeoff (0ft)
    { alt:   610, h:  33, s: 88, l: 51 }, // yellow-orange — 2,000ft
    { alt:  1219, h:  43, s: 88, l: 50 }, // yellow        — 4,000ft
    { alt:  1829, h:  54, s: 88, l: 49 }, // yellow-green  — 6,000ft
    { alt:  2438, h:  72, s: 88, l: 46 }, // green-yellow  — 8,000ft
    { alt:  2743, h:  85, s: 88, l: 44 }, // bright green  — 9,000ft
    { alt:  3353, h: 140, s: 88, l: 41 }, // emerald green — 11,000ft (regional cruise)
    { alt: 12192, h: 300, s: 88, l: 48 }, // purple/magenta— 40,000ft (jet cruise)
    { alt: 15545, h: 360, s: 88, l: 52 }, // red           — 51,000ft+ (extreme)
];

/**
 * Returns the adsb.fi altitude gradient color for a given altitude (metres).
 *
 * scheme = 'TACTICAL'       → uniform #ffce00 (legacy tactical yellow)
 * scheme = 'ALTITUDE'       → smooth HSL gradient (default, matches adsb.fi)
 * scheme = 'ALTITUDE_LIGHT' → dark grey gradient for light map backgrounds
 */
export function getAltitudeColor(altitude, onGround, isEmergency, scheme = 'ALTITUDE') {
    if (isEmergency) return '#ef4444';
    if (scheme === 'TACTICAL') return '#F0C040';

    // Light map mode — dark grey tones so planes are visible on light backgrounds
    if (scheme === 'ALTITUDE_LIGHT') {
        if (onGround || altitude === 'GROUND') return '#6b7280'; // ground: medium grey
        const alt = parseFloat(altitude);
        if (isNaN(alt) || alt <= 0) return '#6b7280';
        // Map altitude to dark grey range: low=#374151, high=#111827
        const pct = Math.min(1, alt / 12000);
        const l = Math.round(40 - pct * 22); // 40% → 18% lightness
        return `hsl(220,15%,${l}%)`;
    }

    if (onGround || altitude === 'GROUND') return '#94a3b8'; // slate — parked / taxiing

    const alt = parseFloat(altitude);
    if (isNaN(alt) || alt <= 0) return '#94a3b8';

    const stops = _ALT_STOPS;
    // Clamp to range
    if (alt >= stops[stops.length - 1].alt) {
        const s = stops[stops.length - 1];
        return `hsl(${s.h},${s.s}%,${s.l}%)`;
    }
    // Find bracketing stops
    let lo = stops[0], hi = stops[1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (alt >= stops[i].alt && alt < stops[i + 1].alt) { lo = stops[i]; hi = stops[i + 1]; break; }
    }
    const t = (hi.alt === lo.alt) ? 1 : (alt - lo.alt) / (hi.alt - lo.alt);
    // Shortest-path hue interpolation (handles the 0°↔360° wrap)
    let dh = hi.h - lo.h;
    if (dh >  180) dh -= 360;
    if (dh < -180) dh += 360;
    const h = ((lo.h + t * dh) % 360 + 360) % 360;
    const s = lo.s + t * (hi.s - lo.s);
    const l = lo.l + t * (hi.l - lo.l);
    return `hsl(${Math.round(h)},${Math.round(s)}%,${Math.round(l)}%)`;
}


/**
 * 產生飛機 SVG HTML
 * OpenSky Categories:
 * 1: No ADS-B Emitter Category Info
 * 2: Light (< 15500 lbs)
 * 3: Small (15500 to 75000 lbs)
 * 4: Large (75000 to 300000 lbs)
 * 5: High Vortex Large
 * 6: Heavy (> 300000 lbs)
 * 7: High Performance (> 5g acceleration and > 400 kts)
 * 8: Rotorcraft (Helicopter)
 * 9: Glider / Sailplane
 * 10: Lighter-than-air
 * 14: UAV (Drone)
 * 15: Space / Trans-atmospheric
 * 16: Surface Vehicle - Emergency
 * 17: Surface Vehicle - Service
 * 18: Point Obstacle
 */
// [OPT 2.2] SVG 生成 LRU 快取，避免每幀對所有飛機重複建立字串
// key: heading_altitude_isSelected_onGround_isEmergency_category_scheme
const _svgCache = new Map();
const _SVG_CACHE_MAX = 500;

export function createPlaneSVG(heading, altitude, isSelected, onGround, isEmergency, category, scheme = 'TACTICAL') {
    // 不要對選中飛機快取（選中狀態爽少）
    if (!isSelected) {
        const cacheKey = `${Math.round(heading)}_${altitude}_0_${onGround ? 1 : 0}_${isEmergency ? 1 : 0}_${category}_${scheme}`;
        if (_svgCache.has(cacheKey)) return _svgCache.get(cacheKey);
        const result = _buildPlaneSVG(heading, altitude, isSelected, onGround, isEmergency, category, scheme);
        if (_svgCache.size >= _SVG_CACHE_MAX) {
            // LRU 送出最舊條目
            _svgCache.delete(_svgCache.keys().next().value);
        }
        _svgCache.set(cacheKey, result);
        return result;
    }
    return _buildPlaneSVG(heading, altitude, isSelected, onGround, isEmergency, category, scheme);
}

function _buildPlaneSVG(heading, altitude, isSelected, onGround, isEmergency, category, scheme = 'TACTICAL') {
    const color = getAltitudeColor(altitude, onGround, isEmergency, scheme);
    const size = onGround ? 26 : Math.min(36, 26 + (altitude !== 'N/A' && altitude !== 'GROUND' ? altitude / 1000 : 0));
    const glowColor = isSelected ? '#FFD700' : color;
    const glow = `drop-shadow(0 0 6px ${glowColor})`;
    const planeColor = isSelected ? '#ffffff' : color;
    const strokeWidth = isSelected ? 1.5 : 1.2;
    const strokeColor = isSelected ? '#FFD700' : 'rgba(255,255,255,0.85)';

    const SVG_PATHS = {
        // Standard Jet (Default / Cat 4 large)
        default: 'M21,16V14L13,9V3.5A1.5,1.5 0 0,0 11.5,2A1.5,1.5 0 0,0 10,3.5V9L2,14V16L10,13.5V19L8,20.5V22L11.5,21L15,22V20.5L13,19V13.5L21,16Z',
        // Heavy / Quad Engine Jet (Cat 5, 6)
        heavy: 'M13.5,9L21.5,15V17L13.5,13.5V19.5L16.5,21.5V23L12,22L7.5,23V21.5L10.5,19.5V13.5L2.5,17V15L10.5,9V3.5C10.5,2 11.5,1 12,1C12.5,1 13.5,2 13.5,3.5Z',
        // Light / Small Propeller (Cat 2, 3)
        light: 'M13.5,9.5L20,13.5V15L13.5,12V18.5L15.5,20.5V22L12,21L8.5,22V20.5L10.5,18.5V12L4,15V13.5L10.5,9.5V3.5C10.5,2.5 11,2 12,2C13,2 13.5,2.5 13.5,3.5Z',
        // Rotorcraft / Helicopter (Cat 8)
        rotorcraft: 'M12,2A2,2 0 0,1 14,4V6H16V4H18V6.5L14,10.5V12H18L20,14V15H18V17A2,2 0 0,1 16,19H14V21H12V19H10A2,2 0 0,1 8,17V15H6V14L8,12V10.5L4,6.5V4H6V6H8V4A2,2 0 0,1 10,2H12Z',
        // Glider / Sailplane (Cat 9) - very long thin wings
        glider: 'M12,2 C13,2 13.5,3 13.5,4 V8 L23.5,9 V10 L13.5,11 V18 L15,19 V20 L12,19 L9,20 V19 L10.5,18 V11 L0.5,10 V9 L10.5,8 V4 C10.5,3 11,2 12,2 Z',
        // UAV / Drone Quadcopter (Cat 14)
        drone: 'M12,10 A2,2 0 1,0 12,14 A2,2 0 1,0 12,10 M4.5,2 A2.5,2.5 0 1,1 4.5,7 A2.5,2.5 0 1,1 4.5,2 M19.5,2 A2.5,2.5 0 1,1 19.5,7 A2.5,2.5 0 1,1 19.5,2 M4.5,17 A2.5,2.5 0 1,1 4.5,22 A2.5,2.5 0 1,1 4.5,17 M19.5,17 A2.5,2.5 0 1,1 19.5,22 A2.5,2.5 0 1,1 19.5,17 M6.5,6 L10,10.5 M17.5,6 L14,10.5 M6.5,18 L10,13.5 M17.5,18 L14,13.5',
        // Ground Vehicle (Cat 16, 17)
        ground: 'M5,11 V19 H19 V11 Z M7,13 H17 V17 H7 Z M10,5 V11 H14 V5 Z M8,19 V21 H10 V19 M14,19 V21 H16 V19'
    };

    let selectedPath = SVG_PATHS.default;

    // Explicit Ground overrides
    if (onGround || altitude === 'GROUND' || category === 16 || category === 17) {
        selectedPath = SVG_PATHS.ground;
    } else if (category === 2 || category === 3) {
        selectedPath = SVG_PATHS.light;
    } else if (category === 5 || category === 6) {
        selectedPath = SVG_PATHS.heavy;
    } else if (category === 8) {
        selectedPath = SVG_PATHS.rotorcraft;
    } else if (category === 9) {
        selectedPath = SVG_PATHS.glider;
    } else if (category === 14) {
        selectedPath = SVG_PATHS.drone;
    }

    // Scale drone or small things up slightly or down so they match the visual weight of the jets
    let scaleTransform = '';
    if (selectedPath === SVG_PATHS.drone) scaleTransform = 'scale(0.85) translate(2, 2)';
    if (selectedPath === SVG_PATHS.heavy) scaleTransform = 'scale(1.1) translate(-1, -1)';

    const svg = `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" style="filter: ${glow}; overflow: visible;">
      <g transform="rotate(${heading} 12 12)">
         <path fill="${planeColor}"
               stroke="${strokeColor}"
               stroke-width="${strokeWidth}"
               stroke-linejoin="round"
               paint-order="stroke fill"
               d="${selectedPath}" transform="${scaleTransform}" />
      </g>
    </svg>
  `;
    return { svg, size };
}

// [Project AERO-SYNC] WebGL / Canvas2D Helper
// [Project AERO-SYNC] WebGL / Canvas2D Helper - Premium High-Fidelity Shapes
export const AERO_PATHS = {
    default: 'M21,16V14L13,9V3.5A1.5,1.5 0 0,0 11.5,2A1.5,1.5 0 0,0 10,3.5V9L2,14V16L10,13.5V19L8,20.5V22L11.5,21L15,22V20.5L13,19V13.5L21,16Z',
    heavy: 'M13.5,9L21.5,15V17L13.5,13.5V19.5L16.5,21.5V23L12,22L7.5,23V21.5L10.5,19.5V13.5L2.5,17V15L10.5,9V3.5C10.5,2 11.5,1 12,1C12.5,1 13.5,2 13.5,3.5Z',
    light: 'M13.5,9.5L20,13.5V15L13.5,12V18.5L15.5,20.5V22L12,21L8.5,22V20.5L10.5,18.5V12L4,15V13.5L10.5,9.5V3.5C10.5,2.5 11,2 12,2C13,2 13.5,2.5 13.5,3.5Z',
    rotorcraft: 'M12,2A2,2 0 0,1 14,4V6H16V4H18V6.5L14,10.5V12H18L20,14V15H18V17A2,2 0 0,1 16,19H14V21H12V19H10A2,2 0 0,1 8,17V15H6V14L8,12V10.5L4,6.5V4H6V6H8V4A2,2 0 0,1 10,2H12Z',
    glider: 'M12,2 C13,2 13.5,3 13.5,4 V8 L23.5,9 V10 L13.5,11 V18 L15,19 V20 L12,19 L9,20 V19 L10.5,18 V11 L0.5,10 V9 L10.5,8 V4 C10.5,3 11,2 12,2 Z',
    drone: 'M12,10 A2,2 0 1,0 12,14 A2,2 0 1,0 12,10 M4.5,2 A2.5,2.5 0 1,1 4.5,7 A2.5,2.5 0 1,1 4.5,2 M19.5,2 A2.5,2.5 0 1,1 19.5,7 A2.5,2.5 0 1,1 19.5,2 M4.5,17 A2.5,2.5 0 1,1 4.5,22 A2.5,2.5 0 1,1 4.5,17 M19.5,17 A2.5,2.5 0 1,1 19.5,22 A2.5,2.5 0 1,1 19.5,17 M6.5,6 L10,10.5 M17.5,6 L14,10.5 M6.5,18 L10,13.5 M17.5,18 L14,13.5',
    ground: 'M5,11 V19 H19 V11 Z M7,13 H17 V17 H7 Z M10,5 V11 H14 V5 Z M8,19 V21 H10 V19 M14,19 V21 H16 V19'
};

export function getPlaneCanvasData(altitude, isSelected, onGround, isEmergency, category, scheme = 'TACTICAL') {
    const color = getAltitudeColor(altitude, onGround, isEmergency, scheme);

    // [v3.5 Fix] Restore EXACT original aesthetics formula and size scaling
    const size = onGround ? 24 : Math.min(36, 24 + (altitude !== 'N/A' && altitude !== 'GROUND' ? altitude / 500 : 0));

    // Restore original colors: selected is YELLOW fill with WHITE stroke. Normal has NO stroke.
    let planeColor = isSelected ? '#FFDC00' : color;
    const strokeColor = isSelected ? '#ffffff' : 'none';
    let strokeWidth = isSelected ? 0.5 : 0;

    let pathMap = AERO_PATHS.default;
    let scale = 1.0;

    if (onGround || altitude === 'GROUND' || category === 16 || category === 17) {
        pathMap = AERO_PATHS.ground;
        strokeWidth = isSelected ? 1 : 0;
        planeColor = isSelected ? '#FFDC00' : color; // Ground vehicles remain solid
    } else if (category === 2 || category === 3) {
        pathMap = AERO_PATHS.light;
    } else if (category === 5 || category === 6) {
        pathMap = AERO_PATHS.heavy;
        scale = 1.1;
    } else if (category === 8) {
        pathMap = AERO_PATHS.rotorcraft;
    } else if (category === 9) {
        pathMap = AERO_PATHS.glider;
    } else if (category === 14) {
        pathMap = AERO_PATHS.drone;
        scale = 0.85;
    }

    return { pathData: pathMap, scale, size, planeColor, strokeColor, strokeWidth, isSelected, isEmergency, onGround, callsign: '', icao24: '' };
}

/**
 * 產生飛機的 CSS class
 */
export function getPlaneExtraClass(isEmergency, onGround) {
    if (isEmergency) return 'emergency-glow';
    if (onGround) return 'ground-glow';
    return '';
}

/**
 * 解析 OpenSky API 回傳資料
 */
export function parseOpenSkyData(data, isStale = false) {
    const planes = [];
    const nowUnix = Math.floor(Date.now() / 1000);

    if (!data.states) return planes;

    data.states.forEach((plane) => {
        const icao24 = plane[0];
        const lastContact = plane[4] || nowUnix;
        const dataAgeSeconds = nowUnix - lastContact;

        // 若非備援資料，且資料超過 120 秒未更新，則拋棄
        if (!isStale && dataAgeSeconds > 120) return;

        const callsign = plane[1] ? plane[1].trim() : 'UNKNOWN';
        let altitude = plane[7] ? Math.round(plane[7]) : 'N/A';
        let onGround = plane[8];
        let velocity = plane[9] || 0;

        if (altitude !== 'N/A' && altitude < 1500 && dataAgeSeconds > 45) {
            onGround = true;
            altitude = 'GROUND';
            velocity = 0;
        }

        const pData = {
            callsign,
            country: plane[2] || 'Unknown',
            lng: plane[5],
            lat: plane[6],
            altitude,
            geoAltitude: plane[13] ? Math.round(plane[13]) : null,
            onGround,
            velocity,
            heading: plane[10] || 0,
            vRate: plane[11] || 0,
            squawk: plane[14] || '',
            spi: plane[15] || false,
            positionSource: plane[16] || 0,
            category: plane[17] || 0,
            isEmergency: ['7700', '7600', '7500'].includes(plane[14]),
            lastContact,
            registration: plane[1] ? plane[1].trim() : 'N/A',
            aircraftType: 'Unknown',
        };

        if (pData.lat && pData.lng) {
            planes.push({ icao24, data: pData });
        }
    });

    return planes;
}

/**
 * 微觀推算 (Micro-Dead Reckoning)
 * 根據真實的當下經緯度、速度、航向，計算 deltaTime 秒後的理論位移點
 */
export function predictPosition(lat, lng, velocity, heading, deltaTime) {
    if (velocity <= 0 || !lat || !lng) return { lat, lng };

    // 每秒移動公尺數
    const dist = velocity * deltaTime;
    const brng = (heading * Math.PI) / 180;
    const lat1 = (lat * Math.PI) / 180;
    const lng1 = (lng * Math.PI) / 180;

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(dist / EARTH_RADIUS) +
        Math.cos(lat1) * Math.sin(dist / EARTH_RADIUS) * Math.cos(brng)
    );
    const lng2 =
        lng1 +
        Math.atan2(
            Math.sin(brng) * Math.sin(dist / EARTH_RADIUS) * Math.cos(lat1),
            Math.cos(dist / EARTH_RADIUS) - Math.sin(lat1) * Math.sin(lat2)
        );

    return {
        lat: (lat2 * 180) / Math.PI,
        lng: (lng2 * 180) / Math.PI,
    };
}

/**
 * 將路徑點在換日線 (IDL) 處切斷，避免橫穿地球的直連線
 * @param {Array} points [[lat, lng], ...]
 * @returns {Array} [[[lat, lng], ...], ...] 段落組成的陣列
 */
export function splitPathAtIDL(points) {
    if (!points || points.length < 2) return [points];

    const segments = [];
    let currentSegment = [[points[0][0], normalizeLongitude(points[0][1])]];

    for (let i = 1; i < points.length; i++) {
        const p1 = currentSegment[currentSegment.length - 1];
        const p1LngSrc = points[i - 1][1];
        const p1LngNor = p1[1];
        const p2LngSrc = points[i][1];
        const p2LngNor = normalizeLongitude(p2LngSrc);

        const p2 = [points[i][0], p2LngNor];

        // 檢測經度突變 (超過 180 度視為跨換日線)
        const lonDiff = Math.abs(p2[1] - p1[1]);
        if (lonDiff > 180) {
            segments.push(currentSegment);
            // When wrapping, we must start a clean new segment
            currentSegment = [p2];
        } else {
            currentSegment.push(p2);
        }
    }
    segments.push(currentSegment);
    return segments;
}

/**
 * 產生大圓航線 (Great Circle) 插補點，用於繪製兩點之間的弧線
 */
export function getGreatCirclePath(p1, p2, numPoints = 60) {
    if (!p1 || !p2) return [];
    let lat1 = p1[0] * Math.PI / 180;
    let lon1 = p1[1] * Math.PI / 180;
    let lat2 = p2[0] * Math.PI / 180;
    let lon2 = p2[1] * Math.PI / 180;

    // 經度正規化處理
    let lonDiff = lon2 - lon1;
    if (lonDiff > Math.PI) lon2 -= 2 * Math.PI;
    if (lonDiff < -Math.PI) lon2 += 2 * Math.PI;

    const d = 2 * Math.asin(Math.sqrt(
        Math.pow(Math.sin((lat1 - lat2) / 2), 2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin((lon1 - lon2) / 2), 2)
    ));

    if (isNaN(d) || d === 0) return [p1, p2];

    const path = [];
    for (let i = 0; i <= numPoints; i++) {
        const f = i / numPoints;
        const A = Math.sin((1 - f) * d) / Math.sin(d);
        const B = Math.sin(f * d) / Math.sin(d);
        const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
        const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
        const z = A * Math.sin(lat1) + B * Math.sin(lat2);
        const lat3 = Math.atan2(z, Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2)));
        const lon3 = Math.atan2(y, x);
        path.push([lat3 * 180 / Math.PI, normalizeLongitude(lon3 * 180 / Math.PI)]);
    }
    return path;
}

/**
 * [Phase 8] 根據當前位移向量產生大圓軌跡 (Trajectory Prediction)
 * 用於繪製飛機未來的預測路徑
 */
export function getGreatCircleTrajectory(lat, lng, velocity, heading, duration = 120, step = 10) {
    if (isNaN(lat) || isNaN(lng) || isNaN(velocity) || isNaN(heading)) return [];

    const points = [];
    for (let t = 0; t <= duration; t += step) {
        const p = predictPosition(lat, lng, velocity, heading, t);
        points.push([p.lat, p.lng]);
    }
    return points;
}

/**
 * 格式化垂直速率
 */
export function formatVerticalRate(vRate) {
    if (!vRate) return '→ Level';
    if (vRate > 0.5) return `↗ ${vRate.toFixed(1)} m/s`;
    if (vRate < -0.5) return `↘ ${vRate.toFixed(1)} m/s`;
    return '→ Level';
}

/**
 * [OPT 3.2] 取得航空公司 Logo URL
 * 自托管於 /airline-logos/{ICAO}.png (Jxck-S/airline-logos, ~1629 airlines)
 * 缺檔時 server 回 204，<img onerror> 可 fallback 到 avs.io IATA
 */
export function getAirlineLogoUrl(callsign) {
    if (!callsign || callsign === 'UNKNOWN') return '';
    const icao = callsign.substring(0, 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(icao)) return '';
    return `/airline-logos/${icao}.png`;
}

/**
 * 取得航空公司 Banner URL (橫幅, 寬高 ~600×50, ~3852 airlines)
 */
export function getAirlineBannerUrl(callsign) {
    if (!callsign || callsign === 'UNKNOWN') return '';
    const icao = callsign.substring(0, 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(icao)) return '';
    return `/airline-banners/${icao}.png`;
}
/**
 * [Project AERO-SYNC] 絕無分配的純數學投影 (Global Space)
 * 轉換經緯度為當前縮放層級下的全域像素座標
 */
export function latLngToGlobalPixels(lat, lng, zoom, outPoint) {
    if (isNaN(lat) || isNaN(lng)) return { x: 0, y: 0 };
    const worldSize = 256 * Math.pow(2, zoom);
    const scaleX = worldSize / 360;
    const scaleY = worldSize / (2 * Math.PI);
    const halfWorld = worldSize / 2;
    const radConst = Math.PI / 360;

    const lngNorm = normalizeLongitude(lng);
    const latClamped = Math.max(-85, Math.min(85, lat));

    const x = (lngNorm + 180) * scaleX;
    const y = halfWorld - Math.log(Math.tan(Math.PI / 4 + latClamped * radConst)) * scaleY;

    if (outPoint) {
        outPoint.x = x;
        outPoint.y = y;
        return outPoint;
    }
    return { x, y };
}
