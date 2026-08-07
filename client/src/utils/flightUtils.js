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
/**
 * 取得可安全送進 /api/flight/complete-details/:hex/:callsign 的 callsign 參數。
 * 地面 ADS-B 訊號常缺真呼號，部分來源會把機型代碼誤填進 callsign 欄位——
 * 這類值等於 icao24、或不符合「2-3 碼英文字母開頭+數字」的呼號格式時一律視為無效。
 */
export function getSafeCallsignParam(plane) {
    const raw = plane?.callsign ? plane.callsign.trim() : '';
    if (!raw) return null;
    if (raw.toUpperCase() === plane?.icao24?.toUpperCase()) return null;
    if (!/^[A-Z]{2,3}\d/.test(raw.toUpperCase())) return null;
    return raw;
}

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
 * SINGLE SOURCE OF TRUTH for aircraft icon color across the whole app.
 * Both the on-map aircraft icons (MapView) and the bottom altitude legend
 * (AltitudeLegend) must derive their colors from this function / the
 * `_ALT_STOPS` ramp it reads from — never hardcode a separate palette.
 *
 * Priority order (highest wins):
 *   1. Emergency (squawk 7500/7600/7700) → fixed alarm red, ignores altitude entirely.
 *   2. Ground / parked                    → the ramp's own GND stop (orange), not an
 *                                            unrelated grey — so a taxiing aircraft's
 *                                            color always matches the legend's "GND" swatch.
 *   3. Airborne                           → smooth HSL interpolation across `_ALT_STOPS`.
 *
 * scheme = 'TACTICAL'       → uniform #ffce00 (legacy tactical yellow, altitude-blind)
 * scheme = 'ALTITUDE'       → smooth HSL gradient (default, matches adsb.fi / the legend)
 * scheme = 'ALTITUDE_LIGHT' → same hue ramp, desaturated/darkened for legibility on a
 *                              light basemap — hue still matches the legend at every
 *                              altitude, only saturation/lightness differ.
 *
 * Selection state is intentionally NOT handled here: callers should keep this
 * function's color as the icon fill and layer a separate outline/glow for
 * "selected", so the altitude-color meaning of the icon is never obscured.
 */
export function getAltitudeColor(altitude, onGround, isEmergency, scheme = 'ALTITUDE') {
    if (isEmergency) return '#ef4444';
    if (scheme === 'TACTICAL') return '#F0C040';

    const isLight = scheme === 'ALTITUDE_LIGHT';
    const stops = _ALT_STOPS;

    // Ground stop lightness/saturation are tuned per-scheme for contrast against
    // the basemap, but the HUE always comes from the same GND stop as the legend.
    const toCss = (h, s, l) => isLight
        ? `hsl(${Math.round(h)},${Math.round(s * 0.75)}%,${Math.max(26, Math.round(l * 0.62))}%)`
        : `hsl(${Math.round(h)},${Math.round(s)}%,${Math.round(l)}%)`;

    if (onGround || altitude === 'GROUND') {
        const g = stops[0];
        return toCss(g.h, g.s, g.l);
    }

    const alt = parseFloat(altitude);
    if (isNaN(alt) || alt <= 0) {
        const g = stops[0];
        return toCss(g.h, g.s, g.l);
    }

    // Clamp to range
    if (alt >= stops[stops.length - 1].alt) {
        const s = stops[stops.length - 1];
        return toCss(s.h, s.s, s.l);
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
    return toCss(h, s, l);
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
// createPlaneSVG / getPlaneCanvasData / getPlaneExtraClass removed — unused,
// superseded by the MapView.jsx Canvas render pipeline (see aircraftIcons.js).

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
