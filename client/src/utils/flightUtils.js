// ==========================================
// Flight Utility Functions
// ==========================================

const EARTH_RADIUS = 6371000;

/**
 * 將經度正規化至 -180 ~ 180 之間
 */
export function normalizeLongitude(lng) {
    while (lng > 180) lng -= 360;
    while (lng < -180) lng += 360;
    return lng;
}

// ==========================================
// 全球主要機場資料庫 (現在由伺服器動態提供)
// ==========================================
export const AIRPORTS = [];

// ==========================================
// 國際機場 IATA 與城市對照表 (從伺服器 API 載入)
// ==========================================
export const getAirportDisplayData = async (code) => {
    if (!code) return null;
    try {
        const response = await fetch(`/api/airport/${code}`);
        if (response.ok) {
            return await response.json();
        }
    } catch (e) {
        console.warn(`[AIRPORT] Failed to fetch data for ${code}:`, e.message);
    }
    return null;
};

// ==========================================
// 航空公司資料庫
// ==========================================
const AIRLINE_DB = {
    // Taiwan
    'CAL': 'China Airlines', 'EVA': 'EVA Air', 'MDA': 'Mandarin Airlines', 'UIA': 'Uni Air', 'TNA': 'TransAsia Airways',
    'TTW': 'Tigerair Taiwan', 'SJX': 'StarLux Airlines', 'FEA': 'Far Eastern Air Transport',
    // Japan
    'JAL': 'Japan Airlines', 'ANA': 'All Nippon Airways', 'JJP': 'Jetstar Japan',
    'APJ': 'Peach Aviation', 'SFJ': 'StarFlyer', 'ADO': 'Air Do', 'SNJ': 'Solaseed Air',
    // Korea
    'KAL': 'Korean Air', 'AAR': 'Asiana Airlines', 'JNA': 'Jin Air', 'TWB': "T'way Air",
    'JJA': 'Jeju Air', 'ABL': 'Air Busan', 'ESR': 'Eastar Jet',
    // China
    'CCA': 'Air China', 'CES': 'China Eastern', 'CSN': 'China Southern', 'HXA': 'Hong Kong Airlines',
    'CPA': 'Cathay Pacific', 'HDA': 'Hong Kong Air Cargo', 'SHQ': 'Spring Airlines',
    'CSZ': 'Shenzhen Airlines', 'CDG': 'Shandong Airlines', 'CHH': 'Hainan Airlines',
    // Southeast Asia
    'SIA': 'Singapore Airlines', 'THA': 'Thai Airways', 'MAS': 'Malaysia Airlines',
    'AXM': 'AirAsia', 'GIA': 'Garuda Indonesia', 'PAL': 'Philippine Airlines',
    'CEB': 'Cebu Pacific', 'VJC': 'Vietjet', 'HVN': 'Vietnam Airlines',
    'JSA': 'Jetstar Asia', 'SLK': 'SilkAir', 'SCO': 'Scoot', 'TGW': 'Scoot',
    // Middle East
    'UAE': 'Emirates', 'ETD': 'Etihad Airways', 'QTR': 'Qatar Airways',
    'THY': 'Turkish Airlines', 'SVA': 'Saudia', 'GFA': 'Gulf Air',
    // Europe
    'BAW': 'British Airways', 'DLH': 'Lufthansa', 'AFR': 'Air France',
    'KLM': 'KLM', 'SAS': 'Scandinavian Airlines', 'FIN': 'Finnair',
    'SWR': 'Swiss Intl', 'AUA': 'Austrian Airlines', 'TAP': 'TAP Portugal',
    'IBE': 'Iberia', 'AZA': 'ITA Airways', 'LOT': 'LOT Polish',
    'EZY': 'easyJet', 'RYR': 'Ryanair', 'WZZ': 'Wizz Air',
    // Americas
    'AAL': 'American Airlines', 'DAL': 'Delta Air Lines', 'UAL': 'United Airlines',
    'SWA': 'Southwest Airlines', 'JBU': 'JetBlue', 'ASA': 'Alaska Airlines',
    'ACA': 'Air Canada', 'TAM': 'LATAM Brasil', 'AVA': 'Avianca',
    // Oceania
    'QFA': 'Qantas', 'ANZ': 'Air New Zealand', 'JST': 'Jetstar Airways',
    'VOZ': 'Virgin Australia',
    // Cargo
    'FDX': 'FedEx Express', 'UPS': 'UPS Airlines', 'GTI': 'Atlas Air',
    'CLX': 'Cargolux', 'CKS': 'Kalitta Air', 'ABW': 'AirBridgeCargo',
    'AHK': 'Air Hong Kong', 'CAO': 'Air China Cargo',
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
// 航空公司 Logo Map (使用 IATA 縮寫)
// ==========================================
export const AIRLINE_LOGOS = {
    // Taiwan
    'CAL': 'CI', 'EVA': 'BR', 'MDA': 'AE', 'UIA': 'B7', 'SJX': 'JX', 'TTW': 'IT', 'FEA': 'FE',
    // Japan
    'JAL': 'JL', 'ANA': 'NH', 'JJP': 'GK', 'APJ': 'MM', 'SFJ': '7G', 'ADO': 'HD', 'SNJ': '6J',
    // Korea
    'KAL': 'KE', 'AAR': 'OZ', 'JNA': 'LJ', 'TWB': 'TW', 'JJA': '7C', 'ABL': 'BX', 'ESR': 'ZE',
    // China
    'CCA': 'CA', 'CES': 'MU', 'CSN': 'CZ', 'HXA': 'HX', 'CPA': 'CX', 'HDA': 'LD', 'SHQ': '9C',
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
    'ACA': 'AC', 'TAM': 'LA', 'AVA': 'AV',
    // Oceania
    'QFA': 'QF', 'ANZ': 'NZ', 'JST': 'JQ', 'VOZ': 'VA',
    // Cargo
    'FDX': 'FX', 'UPS': '5X', 'GTI': '5Y', 'CLX': 'CV', 'CKS': 'K4', 'ABW': 'RU',
    'AHK': 'AHK', 'CAO': 'CA',
};

// ==========================================
// 國家旗幟 Emoji
// ==========================================
const COUNTRY_FLAGS = {
    'Taiwan': '🇹🇼', 'Japan': '🇯🇵', 'South Korea': '🇰🇷', 'Republic of Korea': '🇰🇷',
    'China': '🇨🇳', 'Hong Kong': '🇭🇰', 'Macau': '🇲🇴',
    'Singapore': '🇸🇬', 'Thailand': '🇹🇭', 'Malaysia': '🇲🇾', 'Philippines': '🇵🇭',
    'Indonesia': '🇮🇩', 'Vietnam': '🇻🇳', 'Cambodia': '🇰🇭', 'Myanmar': '🇲🇲',
    'India': '🇮🇳', 'Pakistan': '🇵🇰', 'Bangladesh': '🇧🇩', 'Sri Lanka': '🇱🇰',
    'United States': '🇺🇸', 'Canada': '🇨🇦', 'Mexico': '🇲🇽', 'Brazil': '🇧🇷',
    'Argentina': '🇦🇷', 'Chile': '🇨🇱', 'Colombia': '🇨🇴',
    'United Kingdom': '🇬🇧', 'France': '🇫🇷', 'Germany': '🇩🇪', 'Italy': '🇮🇹',
    'Spain': '🇪🇸', 'Netherlands': '🇳🇱', 'Switzerland': '🇨🇭', 'Austria': '🇦🇹',
    'Sweden': '🇸🇪', 'Norway': '🇳🇴', 'Denmark': '🇩🇰', 'Finland': '🇫🇮',
    'Poland': '🇵🇱', 'Portugal': '🇵🇹', 'Ireland': '🇮🇪', 'Belgium': '🇧🇪',
    'Greece': '🇬🇷', 'Czechia': '🇨🇿', 'Turkey': '🇹🇷', 'Turkiye': '🇹🇷',
    'Russia': '🇷🇺', 'Ukraine': '🇺🇦', 'Israel': '🇮🇱',
    'United Arab Emirates': '🇦🇪', 'Saudi Arabia': '🇸🇦', 'Qatar': '🇶🇦',
    'Australia': '🇦🇺', 'New Zealand': '🇳🇿',
    'South Africa': '🇿🇦', 'Egypt': '🇪🇬', 'Ethiopia': '🇪🇹', 'Kenya': '🇰🇪',
};

/**
 * 取得航空公司名稱
 */
export function getAirlineName(callsign) {
    if (!callsign || callsign === 'UNKNOWN') return '';
    const prefix = callsign.substring(0, 3);
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
export function getCountryFlag(country) {
    if (!country) return '';
    return COUNTRY_FLAGS[country] || '';
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

/**
 * 根據高度回傳對應顏色 (支援多重配色方案)
 */
export function getAltitudeColor(altitude, onGround, isEmergency, scheme = 'TACTICAL') {
    if (isEmergency) return '#ef4444'; // Red-500 (Emergency)
    if (onGround || altitude === 'N/A' || altitude === 'GROUND') return '#64748b'; // Slate-500 (Ground)

    const alt = parseFloat(altitude);

    const SCHEMES = {
        // [v2.6.6] Current Default
        TACTICAL: {
            low: '#f59e0b',    // Amber
            mid: '#10b981',    // Emerald
            high: '#6366f1'    // Indigo
        },
        // [v2.6.5] Classic
        CLASSIC: {
            low: '#fbbf24',    // Amber-400
            mid: '#22d3ee',    // Cyan-400
            high: '#3b82f6'    // Blue-500
        },
        // Maximum Visibility
        VIVID: {
            low: '#fb923c',    // Orange-400
            mid: '#a3e635',    // Lime-400
            high: '#d946ef'    // Fuchsia-500
        },
        // Pro-Contrast
        MONO: {
            low: '#fde047',    // Yellow-300
            mid: '#4ade80',    // Green-400
            high: '#f472b6'    // Pink-400
        },
        // Thermal / Heat look
        HEATMAP: {
            low: '#dc2626',    // Red-600
            mid: '#facc15',    // Yellow-400
            high: '#f8fafc'    // Slate-50
        },
        // Stealth / Night look
        MIDNIGHT: {
            low: '#475569',    // Slate-600
            mid: '#1e3a8a',    // Blue-900
            high: '#7c3aed'    // Violet-600
        }
    };

    const colors = SCHEMES[scheme] || SCHEMES.TACTICAL;

    if (alt < 2500) return colors.low;
    if (alt < 9000) return colors.mid;
    return colors.high;
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
export function createPlaneSVG(heading, altitude, isSelected, onGround, isEmergency, category, scheme = 'TACTICAL') {
    const color = getAltitudeColor(altitude, onGround, isEmergency, scheme);
    const size = onGround ? 26 : Math.min(36, 26 + (altitude !== 'N/A' && altitude !== 'GROUND' ? altitude / 1000 : 0));
    const glowColor = isSelected ? '#f59e0b' : color;
    const glow = `drop-shadow(0 0 6px ${glowColor})`;
    const planeColor = isSelected ? '#ffffff' : color;
    const strokeWidth = isSelected ? 1.5 : 0.8;
    const strokeColor = isSelected ? '#f59e0b' : 'rgba(255,255,255,0.4)';

    // SVG paths centered in a 24x24 viewBox pointing straight UP (to be rotated by CSS)
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
               d="${selectedPath}" transform="${scaleTransform}" />
      </g>
    </svg>
  `;
    return { svg, size };
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
        const p2 = [points[i][0], normalizeLongitude(points[i][1])];

        // 檢測經度突變 (超過 180 度視為跨換日線)
        const lonDiff = Math.abs(p2[1] - p1[1]);
        if (lonDiff > 180) {
            segments.push(currentSegment);
            currentSegment = [];
        }
        currentSegment.push(p2);
    }
    segments.push(currentSegment);
    return segments;
}

/**
 * 產生大圓航線 (Great Circle) 插補點，用於繪製弧線
 * @param {Array} p1 [lat, lng]
 * @param {Array} p2 [lat, lng]
 * @param {number} numPoints 插補點數量
 * @returns {Array} [[lat, lng], ...]
 */
export function getGreatCirclePath(p1, p2, numPoints = 60) {
    let lat1 = p1[0] * Math.PI / 180;
    let lon1 = p1[1] * Math.PI / 180;
    let lat2 = p2[0] * Math.PI / 180;
    let lon2 = p2[1] * Math.PI / 180;

    // 經度正規化處理，確保 lonDiff 在 -PI 到 PI 之間
    let lonDiff = lon2 - lon1;
    if (lonDiff > Math.PI) lon2 -= 2 * Math.PI;
    if (lonDiff < -Math.PI) lon2 += 2 * Math.PI;

    const d = 2 * Math.asin(Math.sqrt(
        Math.pow(Math.sin((lat1 - lat2) / 2), 2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin((lon1 - lon2) / 2), 2)
    ));

    if (d === 0) return [p1, p2];

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

        // 將座標轉回 180 到 -180
        path.push([lat3 * 180 / Math.PI, normalizeLongitude(lon3 * 180 / Math.PI)]);
    }
    return path;
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
 * ICAO 呼號前綴 → IATA 代碼對照表
 * (pics.avs.io 使用 IATA 代碼)
 */
const ICAO_TO_IATA = {
    // Taiwan
    'CAL': 'CI', 'EVA': 'BR', 'MDA': 'AE', 'UIA': 'B7', 'SJX': 'JX', 'TTW': 'IT', 'FEA': 'FE',
    // Japan
    'JAL': 'JL', 'ANA': 'NH', 'JJP': 'GK', 'APJ': 'MM', 'SFJ': '7G', 'ADO': 'HD', 'SNJ': '6J',
    // Korea
    'KAL': 'KE', 'AAR': 'OZ', 'JNA': 'LJ', 'TWB': 'TW', 'JJA': '7C', 'ABL': 'BX', 'ESR': 'ZE',
    // China
    'CCA': 'CA', 'CES': 'MU', 'CSN': 'CZ', 'HXA': 'HX', 'CPA': 'CX', 'SHQ': '9C',
    'CSZ': 'ZH', 'CDG': 'SC', 'CHH': 'HU',
    // Southeast Asia
    'SIA': 'SQ', 'THA': 'TG', 'MAS': 'MH', 'AXM': 'AK', 'GIA': 'GA', 'PAL': 'PR',
    'CEB': '5J', 'VJC': 'VJ', 'HVN': 'VN', 'SCO': 'TR', 'JSA': '3K', 'TGW': 'TR',
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
    'FDX': 'FX', 'UPS': '5X', 'GTI': '5Y', 'CLX': 'CV', 'AHK': 'LD', 'CAO': 'CA',
};

/**
 * 取得航空公司 Logo URL
 * 使用 pics.avs.io CDN (免費，無 hotlink 限制)
 */
export function getAirlineLogoUrl(callsign) {
    if (!callsign || callsign === 'UNKNOWN') return '';
    const prefix = callsign.substring(0, 3);
    const iata = ICAO_TO_IATA[prefix];
    if (!iata) return '';
    return `https://pics.avs.io/200/80/${iata}.png`;
}
