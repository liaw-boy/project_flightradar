// ==========================================
// Flight Utility Functions
// ==========================================

const EARTH_RADIUS = 6371000;

// ==========================================
// 全球主要機場資料庫
// ==========================================
export const AIRPORTS = [
    { icao: 'RCTP', name: 'Taoyuan Intl', lat: 25.0777, lng: 121.2325, type: 'large' },
    { icao: 'RCSS', name: 'Songshan', lat: 25.0694, lng: 121.5525, type: 'medium' },
    { icao: 'RCKH', name: 'Kaohsiung Intl', lat: 22.5771, lng: 120.3500, type: 'large' },
    { icao: 'RCMQ', name: 'Taichung', lat: 24.2647, lng: 120.6208, type: 'medium' },
    { icao: 'RCNN', name: 'Tainan', lat: 22.9504, lng: 120.2057, type: 'small' },
    { icao: 'RCFN', name: 'Hualien', lat: 24.0231, lng: 121.6162, type: 'small' },
    { icao: 'RCQC', name: 'Makung', lat: 23.5687, lng: 119.6283, type: 'small' },
    { icao: 'RJTT', name: 'Tokyo Haneda', lat: 35.5533, lng: 139.7811, type: 'large' },
    { icao: 'RJAA', name: 'Tokyo Narita', lat: 35.7647, lng: 140.3864, type: 'large' },
    { icao: 'RJBB', name: 'Kansai Intl', lat: 34.4347, lng: 135.2441, type: 'large' },
    { icao: 'RJFF', name: 'Fukuoka', lat: 33.5859, lng: 130.4514, type: 'large' },
    { icao: 'RJCC', name: 'Sapporo CTS', lat: 42.7752, lng: 141.6925, type: 'large' },
    { icao: 'ROAH', name: 'Naha Okinawa', lat: 26.1958, lng: 127.6459, type: 'medium' },
    { icao: 'RKSI', name: 'Seoul Incheon', lat: 37.4602, lng: 126.4407, type: 'large' },
    { icao: 'RKSS', name: 'Seoul Gimpo', lat: 37.5583, lng: 126.7906, type: 'medium' },
    { icao: 'ZBAA', name: 'Beijing Capital', lat: 40.0801, lng: 116.5846, type: 'large' },
    { icao: 'ZSPD', name: 'Shanghai Pudong', lat: 31.1434, lng: 121.8052, type: 'large' },
    { icao: 'ZSSS', name: 'Shanghai Hongqiao', lat: 31.1979, lng: 121.3362, type: 'large' },
    { icao: 'ZGGG', name: 'Guangzhou Baiyun', lat: 23.3924, lng: 113.2988, type: 'large' },
    { icao: 'ZGSZ', name: 'Shenzhen Baoan', lat: 22.6393, lng: 113.8107, type: 'large' },
    { icao: 'VHHH', name: 'Hong Kong Intl', lat: 22.3089, lng: 113.9146, type: 'large' },
    { icao: 'WSSS', name: 'Singapore Changi', lat: 1.3502, lng: 103.9944, type: 'large' },
    { icao: 'VTBS', name: 'Bangkok Suvarnabhumi', lat: 13.6900, lng: 100.7501, type: 'large' },
    { icao: 'WMKK', name: 'Kuala Lumpur KLIA', lat: 2.7456, lng: 101.7099, type: 'large' },
    { icao: 'RPLL', name: 'Manila NAIA', lat: 14.5086, lng: 121.0198, type: 'large' },
    { icao: 'WIII', name: 'Jakarta Soekarno', lat: -6.1256, lng: 106.6558, type: 'large' },
    { icao: 'VVNB', name: 'Hanoi Noi Bai', lat: 21.2212, lng: 105.8072, type: 'large' },
    { icao: 'VVTS', name: 'Ho Chi Minh', lat: 10.8188, lng: 106.6519, type: 'large' },
    { icao: 'VIDP', name: 'Delhi Intl', lat: 28.5665, lng: 77.1031, type: 'large' },
    { icao: 'OMDB', name: 'Dubai Intl', lat: 25.2528, lng: 55.3644, type: 'large' },
    { icao: 'OTHH', name: 'Doha Hamad', lat: 25.2731, lng: 51.6082, type: 'large' },
    { icao: 'EGLL', name: 'London Heathrow', lat: 51.4700, lng: -0.4543, type: 'large' },
    { icao: 'LFPG', name: 'Paris CDG', lat: 49.0097, lng: 2.5479, type: 'large' },
    { icao: 'EDDF', name: 'Frankfurt', lat: 50.0379, lng: 8.5622, type: 'large' },
    { icao: 'EHAM', name: 'Amsterdam Schiphol', lat: 52.3086, lng: 4.7639, type: 'large' },
    { icao: 'LTFM', name: 'Istanbul', lat: 41.2611, lng: 28.7419, type: 'large' },
    { icao: 'KJFK', name: 'New York JFK', lat: 40.6413, lng: -73.7781, type: 'large' },
    { icao: 'KLAX', name: 'Los Angeles LAX', lat: 33.9416, lng: -118.4085, type: 'large' },
    { icao: 'KORD', name: 'Chicago OHare', lat: 41.9742, lng: -87.9073, type: 'large' },
    { icao: 'KATL', name: 'Atlanta', lat: 33.6407, lng: -84.4277, type: 'large' },
    { icao: 'YSSY', name: 'Sydney', lat: -33.9461, lng: 151.1772, type: 'large' },
    { icao: 'NZAA', name: 'Auckland', lat: -37.0082, lng: 174.7850, type: 'large' },
];

// ==========================================
// 國際機場 IATA 與城市對照表 (從全球資料庫載入)
// ==========================================
export { getAirportDisplayData } from './airportMappings';

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
const AIRLINE_LOGOS = {
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
 * Haversine 大圓距離
 */
function haversine(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
 * 根據高度回傳對應顏色
 */
export function getAltitudeColor(altitude, onGround, isEmergency) {
    if (isEmergency) return '#FF4136';
    if (onGround) return '#888888';
    if (altitude === 'N/A' || altitude === 'GROUND') return '#888';
    if (altitude < 1500) return '#FF4136';
    if (altitude < 5000) return '#FFDC00';
    return '#01FF70';
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
export function createPlaneSVG(heading, altitude, isSelected, onGround, isEmergency, category) {
    const color = getAltitudeColor(altitude, onGround, isEmergency);
    const size = onGround ? 24 : Math.min(36, 24 + (altitude !== 'N/A' && altitude !== 'GROUND' ? altitude / 500 : 0));
    const glow = isSelected ? 'drop-shadow(0 0 15px #FFDC00)' : `drop-shadow(0 0 6px ${color})`;
    const planeColor = isSelected ? '#FFDC00' : color;

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
    if (onGround) {
        // If it's a known service vehicle category or literally on the ground
        if (category === 16 || category === 17) selectedPath = SVG_PATHS.ground;
    }

    if (category === 2 || category === 3) selectedPath = SVG_PATHS.light;
    else if (category === 5 || category === 6) selectedPath = SVG_PATHS.heavy;
    else if (category === 8) selectedPath = SVG_PATHS.rotorcraft;
    else if (category === 9) selectedPath = SVG_PATHS.glider;
    else if (category === 14) selectedPath = SVG_PATHS.drone;
    else if (category === 16 || category === 17) selectedPath = SVG_PATHS.ground;

    // Scale drone or small things up slightly or down so they match the visual weight of the jets
    let scaleTransform = '';
    if (selectedPath === SVG_PATHS.drone) scaleTransform = 'scale(0.85) translate(2, 2)';
    if (selectedPath === SVG_PATHS.heavy) scaleTransform = 'scale(1.1) translate(-1, -1)';

    const svg = `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" style="filter: ${glow};">
      <g transform="rotate(${heading} 12 12)">
         <path fill="${planeColor}" stroke="${isSelected ? '#fff' : 'none'}" stroke-width="${isSelected ? 0.5 : 0}"
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
 * 大圓航線位置預測
 */
export function predictPosition(plane, deltaTime) {
    if (plane.onGround || plane.velocity <= 0) return { lat: plane.lat, lng: plane.lng };

    const nowUnix = Math.floor(Date.now() / 1000);
    const dataAge = nowUnix - plane.lastContact;
    if (dataAge >= 60) return { lat: plane.lat, lng: plane.lng };

    let currentVelocity = plane.velocity;
    if (plane.altitude !== 'N/A' && plane.altitude !== 'GROUND' && plane.altitude < 1500) {
        const brakingFactor = Math.max(0.1, 1 - (dataAge / 45));
        currentVelocity *= brakingFactor;
    }

    if (currentVelocity <= 0) return { lat: plane.lat, lng: plane.lng };

    const dist = currentVelocity * deltaTime;
    const brng = (plane.heading * Math.PI) / 180;
    const lat1 = (plane.lat * Math.PI) / 180;
    const lng1 = (plane.lng * Math.PI) / 180;

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
