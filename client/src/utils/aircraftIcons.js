/**
 * AIRCRAFT ICONS ENGINE V2
 * 
 * 包含 9 種機型 SVG 路徑、機型對應表、以及高度顯色邏輯。
 * 單位說明：高度（altitude）為公尺 (m)。
 */

// 核心 SVG 路徑庫 (viewBox="0 0 100 100", 機頭朝上)
export const AIRCRAFT_SVGS = {
    // 1. 巨無霸 (B747, A380) - 4 引擎，巨大翼展
    wide_body_4engine: 'M50,5 L54,15 L54,35 L95,65 L95,75 L54,55 L54,80 L65,90 L65,95 L50,92 L35,95 L35,90 L46,80 L46,55 L5,75 L5,65 L46,35 L46,15 Z M70,55 L70,62 L78,62 L78,55 Z M82,60 L82,67 L90,67 L90,60 Z M10,60 L10,67 L18,67 L18,60 Z M22,55 L22,62 L30,62 L30,55 Z',
    
    // 2. 廣體 (B787, A330, A350) - 2 引擎，修長翼展
    wide_body_2engine: 'M50,5 L54,15 L54,35 L98,62 L98,72 L54,52 L54,82 L65,92 L65,97 L50,94 L35,97 L35,92 L46,82 L46,52 L2,72 L2,62 L46,35 L46,15 Z M72,53 L72,62 L82,62 L82,53 Z M18,53 L18,62 L28,62 L28,53 Z',
    
    // 3. 窄體 (B737, A320) - 標準 2 引擎客機
    narrow_body_2engine: 'M50,8 L54,18 L54,38 L92,65 L92,75 L54,58 L54,82 L63,90 L63,95 L50,92 L37,95 L37,90 L46,82 L46,58 L8,75 L8,65 L46,38 L46,18 Z M68,58 L68,66 L78,66 L78,58 Z M22,58 L22,66 L32,66 L32,58 Z',
    
    // 4. 區域航線客機 (E190, CRJ) - 尾部引擎，T型或標準尾翼
    regional_jet: 'M50,5 L53,15 L53,60 L88,72 L88,80 L53,70 L53,88 L65,95 L65,98 L50,96 L35,98 L35,95 L47,88 L47,70 L12,80 L12,72 L47,60 L47,15 Z M42,65 L42,75 L47,75 L47,65 Z M53,65 L53,75 L58,75 L58,65 Z',
    
    // 5. 渦輪螺旋槳 (DH8D, AT72) - 高單翼，螺旋槳細節
    turboprop: 'M50,5 L53,15 L53,30 L95,30 L95,42 L53,42 L53,85 L65,95 L65,98 L50,96 L35,98 L35,95 L47,85 L47,42 L5,42 L5,30 L47,30 L47,15 Z M65,25 L65,45 M35,25 L35,45 M70,36 C75,36 75,24 70,24 C65,24 65,36 70,36 Z M30,36 C35,36 35,24 30,24 C25,24 25,36 30,36 Z',
    
    // 6. 小型活塞機 (C172) - 輕航機，前方螺旋槳
    small_piston: 'M50,15 L52,25 L52,40 L90,40 L90,48 L52,48 L52,85 L62,92 L62,96 L50,94 L38,96 L38,92 L48,48 L48,48 L10,48 L10,40 L48,40 L48,25 Z M45,10 L55,10 M50,5 L50,15',
    
    // 7. 直升機 (EC35, R44) - 頂部旋翼
    helicopter: 'M50,40 A10,10 0 1,0 50,60 A10,10 0 1,0 50,40 Z M50,5 L50,95 M5,50 L95,50 M50,50 L85,15 M50,50 L15,85 M50,50 L15,15 M50,50 L85,85',
    
    // 8. 協和號 (Concorde) - 三角翼
    concorde: 'M50,2 L53,20 L53,45 L85,85 L85,90 L53,80 L53,95 L50,98 L47,95 L47,80 L15,90 L15,85 L47,45 L47,20 Z',
    
    // 9. 預設喷射機 (Default)
    default_jet: 'M50,5 L55,20 L55,45 L90,70 L90,80 L55,65 L55,85 L65,95 L50,92 L35,95 L45,85 L45,65 L10,80 L10,70 L45,45 L45,20 Z'
};

// 機型代碼對應表
const AIRCRAFT_TYPE_MAP = {
    // wide_body_4engine
    'B741': 'wide_body_4engine', 'B742': 'wide_body_4engine', 'B743': 'wide_body_4engine', 
    'B744': 'wide_body_4engine', 'B748': 'wide_body_4engine', 'B74F': 'wide_body_4engine',
    'A380': 'wide_body_4engine', 'A388': 'wide_body_4engine', 
    'A342': 'wide_body_4engine', 'A343': 'wide_body_4engine', 'A345': 'wide_body_4engine', 'A346': 'wide_body_4engine',
    'AN12': 'wide_body_4engine',

    // wide_body_2engine
    'B772': 'wide_body_2engine', 'B773': 'wide_body_2engine', 'B77W': 'wide_body_2engine', 'B77F': 'wide_body_2engine',
    'B788': 'wide_body_2engine', 'B789': 'wide_body_2engine', 'B78X': 'wide_body_2engine',
    'A332': 'wide_body_2engine', 'A333': 'wide_body_2engine', 'A338': 'wide_body_2engine', 'A339': 'wide_body_2engine',
    'A359': 'wide_body_2engine', 'A35K': 'wide_body_2engine',
    'B762': 'wide_body_2engine', 'B763': 'wide_body_2engine', 'B764': 'wide_body_2engine',
    'MD11': 'wide_body_2engine', 'DC10': 'wide_body_2engine',

    // narrow_body_2engine
    'B735': 'narrow_body_2engine', 'B736': 'narrow_body_2engine', 'B737': 'narrow_body_2engine', 
    'B738': 'narrow_body_2engine', 'B739': 'narrow_body_2engine', 
    'B37M': 'narrow_body_2engine', 'B38M': 'narrow_body_2engine', 'B39M': 'narrow_body_2engine',
    'A318': 'narrow_body_2engine', 'A319': 'narrow_body_2engine', 'A320': 'narrow_body_2engine', 'A321': 'narrow_body_2engine',
    'A20N': 'narrow_body_2engine', 'A21N': 'narrow_body_2engine',
    'B752': 'narrow_body_2engine', 'B753': 'narrow_body_2engine',
    'BCS1': 'narrow_body_2engine', 'BCS3': 'narrow_body_2engine',

    // regional_jet
    'E170': 'regional_jet', 'E175': 'regional_jet', 'E190': 'regional_jet', 'E195': 'regional_jet',
    'E290': 'regional_jet', 'E295': 'regional_jet',
    'CRJ2': 'regional_jet', 'CRJ7': 'regional_jet', 'CRJ9': 'regional_jet', 'CRJX': 'regional_jet',
    'SU95': 'regional_jet',

    // turboprop
    'DH8A': 'turboprop', 'DH8B': 'turboprop', 'DH8C': 'turboprop', 'DH8D': 'turboprop',
    'AT72': 'turboprop', 'AT75': 'turboprop', 'AT76': 'turboprop',
    'AT43': 'turboprop', 'AT45': 'turboprop',

    // small_piston
    'PC12': 'small_piston', 'C208': 'small_piston', 'C172': 'small_piston', 'C152': 'small_piston', 'SR22': 'small_piston',

    // helicopter
    'EC35': 'helicopter', 'B06': 'helicopter', 'R44': 'helicopter', 'S76': 'helicopter', 'H60': 'helicopter',

    // concorde
    'CONC': 'concorde'
};

/**
 * 根據 ICAO 機型代碼取得圖示類型
 */
export function getAircraftIconType(icaoType) {
    if (!icaoType) return 'default_jet';
    
    const type = icaoType.toUpperCase();
    if (AIRCRAFT_TYPE_MAP[type]) return AIRCRAFT_TYPE_MAP[type];

    // 前綴模糊匹配
    if (type.startsWith('B74') || type.startsWith('A38') || type.startsWith('A34')) return 'wide_body_4engine';
    if (type.startsWith('B77') || type.startsWith('B78') || type.startsWith('A33') || type.startsWith('A35') || type.startsWith('B76')) return 'wide_body_2engine';
    if (type.startsWith('B73') || type.startsWith('A31') || type.startsWith('A32') || type.startsWith('A20') || type.startsWith('A21')) return 'narrow_body_2engine';
    if (type.startsWith('E1') || type.startsWith('CRJ')) return 'regional_jet';
    if (type.startsWith('DH8') || type.startsWith('AT7') || type.startsWith('AT4')) return 'turboprop';
    if (type.startsWith('C1') || type.startsWith('SR')) return 'small_piston';
    
    return 'default_jet';
}

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
 * [Compatibility] 取得飛機圖示 URL (SVG Data URI)
 */
export function getAircraftIconUrl(plane) {
    const iconType = getAircraftIconType(plane.aircraft_type || plane.typecode);
    const color = getAltitudeColor(plane.altitude);
    const svgPath = AIRCRAFT_SVGS[iconType] || AIRCRAFT_SVGS.default_jet;

    const svgString = `<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="${svgPath}" fill="${color}" /></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
}
