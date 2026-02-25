import React, { createContext, useContext, useState, useCallback } from 'react';

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
    },
};

const I18nContext = createContext();

export function I18nProvider({ children }) {
    const [lang, setLang] = useState('en');

    const toggleLang = useCallback(() => {
        setLang((prev) => (prev === 'en' ? 'cn' : 'en'));
    }, []);

    const t = useCallback(
        (key) => translations[lang]?.[key] || translations.en[key] || key,
        [lang]
    );

    return (
        <I18nContext.Provider value={{ lang, toggleLang, t }}>
            {children}
        </I18nContext.Provider>
    );
}

export function useI18n() {
    return useContext(I18nContext);
}
