import React, { createContext, useContext, useState, useCallback } from 'react';

/**
 * METAR 專用氣象術語字典 (解碼對照表)
 */
const metarDictionary = {
    cn: {
        'FEW': '疏雲',
        'SCT': '散雲',
        'BKN': '裂雲',
        'OVC': '密雲',
        'CAVOK': '晴空萬里',
        'NSC': '無顯著雲層',
        'SKC': '晴朗',
        'CLR': '晴朗',
        'Variable': '風向不定',
        'Elev': '標高',
        // 天氣現象
        'RA': '降雨',
        'SN': '降雪',
        'TS': '雷暴',
        'FG': '霧',
        'BR': '薄霧',
        'HZ': '霾',
        'DZ': '毛毛雨',
        'VC': '附近有',
        // 風向方位
        'N': '北風', 'NNE': '北北東風', 'NE': '東北風', 'ENE': '東北東風',
        'E': '東風', 'ESE': '東南東風', 'SE': '東南風', 'SSE': '南南東風',
        'S': '南風', 'SSW': '南南西風', 'SW': '西南風', 'WSW': '西南西風',
        'W': '西風', 'WNW': '西北西風', 'NW': '西北風', 'NNW': '北北西風'
    },
    en: {
        'Variable': 'Variable',
        'Elev': 'Elev',
        'N': 'North', 'NE': 'Northeast', 'E': 'East', 'SE': 'Southeast',
        'S': 'South', 'SW': 'Southwest', 'W': 'West', 'NW': 'Northwest'
    }
};

/**
 * 多語言翻譯資料庫 (EN / 中文)
 */
const translations = {
    en: {
        // Dashboard
        radarSystem: 'RADAR SYSTEM',
        sysTime: 'SYS.TIME',
        aircraft: 'AIRCRAFT',
        scanning: 'SCANNING',
        airGround: '✈️ AIR / 🛬 GND',
        apiStatus: 'API STATUS',
        latency: 'LATENCY',
        lastUpdate: 'LAST UPDATE',
        nextRefresh: 'NEXT REFRESH',
        apiCalls: '📊 API CALLS',
        rateLimits: '⚠️ RATE LIMITS',
        dbCache: '💾 DB CACHE',
        quota: 'QUOTA:',
        unlocks: 'UNLOCKS:',
        resets: 'RESETS:',
        limitsHit: 'LIMITS HIT:',
        restricted: 'RESTRICTED',
        active: 'ACTIVE',
        // Filters
        filters: '🎛️ FILTERS',
        showGround: 'Show Ground',
        showEmergency: 'Show Emergency',
        showLow: 'Show Low Alt (<1500m)',
        showAirports: 'Show Airports',
        // Sidebar
        flightIdentity: '✈️ FLIGHT IDENTITY',
        icao24: 'ICAO24',
        registration: 'Registration',
        country: 'Country',
        airline: 'Airline',
        category: 'Category',
        type: 'Type',
        spatialData: '📊 SPATIAL DATA',
        altitude: 'Altitude',
        gpsAlt: 'GPS Alt',
        speed: 'Speed',
        heading: 'Heading',
        vertRate: 'Vert. Rate',
        position: 'Position',
        source: 'Source',
        status: '📡 STATUS',
        squawk: 'Squawk',
        spiLabel: 'SPI',
        lastContact: 'Last Contact',
        dataAge: 'Data Age',
        nearestAirport: '🏗️ NEAREST AIRPORT',
        airport: 'Airport',
        distance: 'Distance',
        trackOnFR24: '🔍 Track on Flightradar24 ↗',
        // Search
        searchPlaceholder: '🔍 Search flight (eg: CX123)',
        // Notification
        radarStarted: '🚀 Radar system started',
        // Weather
        weatherData: 'No weather data available',
        weatherFailed: 'Failed to load weather',
        metarTemp: 'Temp',
        metarDew: 'Dewpt',
        metarWind: 'Wind',
        metarVis: 'Visib',
        metarClouds: 'Clouds',
        metarBaro: 'Baro'
    },
    cn: {
        // Dashboard
        radarSystem: '雷達系統',
        sysTime: '系統時間',
        aircraft: '航機數量',
        scanning: '掃描中',
        airGround: '✈️ 空中 / 🛬 地面',
        apiStatus: 'API 狀態',
        latency: '延遲',
        lastUpdate: '最後更新',
        nextRefresh: '下次刷新',
        apiCalls: '📊 API 呼叫',
        rateLimits: '⚠️ 限流次數',
        dbCache: '💾 快取數量',
        quota: '剩餘配額:',
        unlocks: '解鎖時間:',
        resets: '重置時間:',
        limitsHit: '限流累計:',
        restricted: '存取受限',
        active: '正常運作',
        // Filters
        filters: '🎛️ 篩選器',
        showGround: '顯示地面',
        showEmergency: '顯示緊急',
        showLow: '顯示低空 (<1500m)',
        showAirports: '顯示機場',
        // Sidebar
        flightIdentity: '✈️ 航班身份',
        icao24: 'ICAO24',
        registration: '航機註冊號',
        country: '國家',
        airline: '航空公司',
        category: '類別',
        type: '機型',
        spatialData: '📊 空間資料',
        altitude: '高度',
        gpsAlt: 'GPS 高度',
        speed: '速度',
        heading: '航向',
        vertRate: '垂直速率',
        position: '座標',
        source: '位置來源',
        status: '📡 狀態',
        squawk: '應答機碼',
        spiLabel: 'SPI',
        lastContact: '最後聯繫',
        dataAge: '資料年齡',
        nearestAirport: '🏗️ 最近機場',
        airport: '機場',
        distance: '距離',
        trackOnFR24: '🔍 在 Flightradar24 追蹤 ↗',
        // Search
        searchPlaceholder: '🔍 搜尋航班號 (例: CX123)',
        // Notification
        radarStarted: '🚀 雷達系統已啟動',
        // Weather
        weatherData: '無氣象觀測資料',
        weatherFailed: '氣象資料載入失敗',
        metarTemp: '溫度',
        metarDew: '露點',
        metarWind: '風向',
        metarVis: '能見度',
        metarClouds: '雲層',
        metarBaro: '氣壓'
    },
};

/**
 * 機場名稱在地化辭典 (常用國際機場)
 */
const airportNames = {
    cn: {
        'RCTP': '桃園國際機場', 'RCSS': '台北松山機場', 'RCKH': '高雄國際機場', 'RCMQ': '台中機場',
        'RCNN': '台南機場', 'RCFN': '花蓮機場', 'RCQC': '澎湖馬公機場',
        'RJTT': '東京羽田機場', 'RJAA': '東京成田機場', 'RJBB': '大阪關西機場', 'RJFF': '福岡機場',
        'RJCC': '新千歲機場', 'ROAH': '那霸機場', 'RKSI': '首爾仁川機場', 'RKSS': '首爾金浦機場',
        'ZBAA': '北京首都機場', 'ZSPD': '上海浦東機場', 'ZSSS': '上海虹橋機場', 'ZGGG': '廣州白雲機場',
        'ZGSZ': '深圳寶安機場', 'VHHH': '香港國際機場', 'WSSS': '新加坡樟宜機場', 'VTBS': '曼谷蘇凡納布機場',
        'WMKK': '吉隆坡國際機場', 'RPLL': '馬尼拉機場', 'WIII': '雅加達機場', 'VVNB': '河內機場',
        'VVTS': '胡志明市機場', 'VIDP': '新德里機場', 'OMDB': '杜拜國際機場', 'OTHH': '多哈機場',
        'EGLL': '倫敦希斯洛機場', 'LFPG': '巴黎戴高樂機場', 'EDDF': '法蘭克福機場', 'EHAM': '阿姆斯特丹史基浦機場',
        'LTFM': '伊斯坦堡機場', 'KJFK': '紐約甘迺迪機場', 'KLAX': '洛杉磯國際機場', 'KORD': '芝加哥歐海爾機場',
        'KATL': '亞特蘭大機場', 'YSSY': '雪梨機場', 'NZAA': '奧克蘭機場'
    }
};

const I18nContext = createContext();

export function I18nProvider({ children }) {
    const [lang, setLang] = useState('en');

    const toggleLang = useCallback(() => {
        setLang((prev) => (prev === 'en' ? 'cn' : 'en'));
    }, []);

    const t = useCallback(
        (key, data) => {
            // 特別處理機場名稱翻譯
            if (key === 'airportName' && data) {
                return airportNames[lang]?.[data] || null;
            }
            return translations[lang]?.[key] || translations.en[key] || key;
        },
        [lang]
    );

    /**
     * 人性化氣象譯碼器 (METAR Decoder)
     */
    const translateMetar = useCallback((str, type) => {
        if (!str) return '';
        const isCn = lang === 'cn';
        const dict = metarDictionary[lang] || {};

        const getDirName = (deg) => {
            if (deg === 'VRB') return dict['Variable'] || 'Variable';
            const d = parseFloat(deg);
            const sectors = isCn
                ? ['北', '北北東', '東北', '東北東', '東', '東南東', '東南', '南南東', '南', '南南西', '西南', '西南西', '西', '西北西', '西北', '北北西']
                : ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
            return (sectors[Math.round(d / 22.5) % 16] || '') + (isCn ? '風' : '');
        };

        switch (type) {
            case 'WIND': // Input: "280° 6kt"
                const wParts = str.split(' ');
                const deg = wParts[0]?.replace('°', '');
                const spd = wParts[1]?.replace('kt', '');
                const dirName = getDirName(deg);
                return isCn ? `${dirName} ${spd}節` : `${dirName} ${spd}kts`;

            case 'VISIB': // Input: "6+ SM"
                const vMatch = str.match(/(\d+)\+?\s*SM/);
                if (vMatch) {
                    const sm = parseInt(vMatch[1]);
                    const km = Math.round(sm * 1.609);
                    if (str.includes('+')) {
                        return isCn ? `大於 ${km}公里` : `Greater than ${km}km`;
                    }
                    return isCn ? `${km}公里` : `${km}km`;
                }
                return str;

            case 'CLOUDS': // Input: "FEW 2000ft, SCT 4500ft"
                return str.split(', ').map(c => {
                    const cParts = c.split(' ');
                    const cover = dict[cParts[0]] || cParts[0];
                    const base = cParts[1]?.replace('ft', '') || '';
                    return isCn ? `${base}呎 ${cover}` : `${cover} at ${base}ft`;
                }).join(', ');

            case 'ALTIM': // Input: "1009 hPa"
                const hpa = str.replace(' hPa', '');
                return isCn ? `${hpa} 百帕` : `${hpa} hPa`;

            default:
                // Fallback direct dictionary replacement (Only if CN)
                if (!isCn) return str;
                let translated = str;
                const cnDict = metarDictionary.cn;
                for (const [key, val] of Object.entries(cnDict)) {
                    translated = translated.replace(new RegExp(`\\b${key}\\b`, 'g'), val);
                }
                return translated;
        }
    }, [lang]);

    return (
        <I18nContext.Provider value={{ lang, toggleLang, t, translateMetar }}>
            {children}
        </I18nContext.Provider>
    );
}

export function useI18n() {
    return useContext(I18nContext);
}
