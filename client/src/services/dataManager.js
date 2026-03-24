/**
 * dataManager.js - AERO-SYNC 統一資料獲取門面 (Data Facade)
 * 管理 L1 (Store), L2 (LRU), L3 (IndexedDB) 與 外部 API 的調度
 */

import { idb, lruCache } from './storageManager';
import { logger } from '../utils/logger';

export const dataManager = {
    /**
     * [L3 -> API] 獲取機場完整清單
     * 策略：先看 IndexedDB 是否有資料，若無才 Fetch，並非同步存入 DB。
     */
    async getAirports() {
        try {
            const cachedAirports = await idb.getAll('airports');
            if (cachedAirports && cachedAirports.length > 5000) {
                logger.debug('CACHE', `L3 hit: ${cachedAirports.length} airports`);
                return cachedAirports;
            }

            logger.info('FETCH', 'Airport L3 cache miss — fetching from API');
            const response = await fetch('/api/airports/list');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const airports = await response.json();
            idb.putAll('airports', airports).catch(err => logger.warn('CACHE', `L3 airport write failed: ${err.message}`));
            return airports;
        } catch (error) {
            logger.error('FETCH', `Airport loading failed: ${error.message}`);
            return [];
        }
    },

    /**
     * [L2 -> API] 獲取指定機場的 METAR 天氣
     */
    async getMetar(icao) {
        const cacheKey = `metar_${icao}`;
        const cached = lruCache.get(cacheKey);
        if (cached) {
            logger.debug('CACHE', `L2 hit (METAR): ${icao}`);
            return cached;
        }

        try {
            const response = await fetch(`/api/metar?icao=${icao}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            lruCache.put(cacheKey, data);
            return data;
        } catch (error) {
            logger.warn('FETCH', `METAR failed for ${icao}: ${error.message}`);
            return { error: true, message: error.message };
        }
    },

    /**
     * [L2 -> API] 獲取航線推斷結果
     */
    async getRoute(icao24, callsign) {
        const cacheKey = `route_${icao24}`;
        const cached = lruCache.get(cacheKey);
        if (cached) return cached;

        try {
            const response = await fetch(`/api/route/${icao24}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            let data = await response.json();

            if ((!data || data.noData || !data.departureAirport) && callsign) {
                logger.debug('FETCH', `Local route inference miss for ${callsign} — trying external fallback`);
                const extRes = await fetch(`/api/route/external?callsign=${callsign}`);
                if (extRes.ok) {
                    const extData = await extRes.json();
                    if (extData && extData.departureAirport) data = extData;
                }
            }

            lruCache.put(cacheKey, data);
            return data;
        } catch (err) {
            logger.warn('FETCH', `Route resolution failed for ${icao24}: ${err.message}`);
            return null;
        }
    },

    /**
     * [L2 -> API] 獲取歷史軌跡
     */
    async getTrack(icao24, lastContact, forceRefresh = false) {
        const cacheKey = `track_${icao24}_${lastContact || 'live'}`;
        if (!forceRefresh) {
            const cached = lruCache.get(cacheKey);
            if (cached) return cached;
        }

        try {
            const timeParam = lastContact ? `&time=${lastContact}` : '';
            const res = await fetch(`/api/tracks?icao24=${icao24}${timeParam}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            lruCache.put(cacheKey, data);
            return data;
        } catch (err) {
            throw err;
        }
    },

    /**
     * [L2 -> API] 獲取飛機詳細 Meta 資料
     */
    async getMetadata(icao24) {
        const cacheKey = `metadata_${icao24}`;
        const cached = lruCache.get(cacheKey);
        if (cached) return cached;

        try {
            const res = await fetch(`/api/metadata/${icao24}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            lruCache.put(cacheKey, data);
            return data;
        } catch (err) {
            return { noData: true };
        }
    },

    /**
     * [L2 -> API] 獲取航空公司詳細資訊
     */
    async getAirline(callsign) {
        if (!callsign || callsign === 'N/A' || callsign === 'UNKNOWN') return { name: "Unknown", logo: null };
        const cacheKey = `airline_${callsign}`;
        const cached = lruCache.get(cacheKey);
        if (cached) return cached;

        try {
            const res = await fetch(`/api/airline/${callsign}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            lruCache.put(cacheKey, data);
            return data;
        } catch (err) {
            return { name: "Unknown", logo: null };
        }
    },

    /**
     * [L2 -> API] 獲取 AircraftRegistry 資訊
     */
    async getAircraftRegistry(icao24) {
        if (!icao24) return null;
        const cacheKey = `registry_${icao24}`;
        const cached = lruCache.get(cacheKey);
        if (cached) return cached;

        try {
            const res = await fetch(`/api/aircraft/${icao24}?v=${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            lruCache.put(cacheKey, data);
            return data;
        } catch (err) {
            logger.warn('FETCH', `Registry fetch failed for ${icao24}: ${err.message}`);
            return null;
        }
    },

    /**
     * [L2 -> API] 獲取單一機場詳細資訊
     */
    async getAirport(code) {
        if (!code || code === 'N/A') return null;
        const cacheKey = `airport_${code}`;
        const cached = lruCache.get(cacheKey);
        if (cached) return cached;

        try {
            const res = await fetch(`/api/airport/${code}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            lruCache.put(cacheKey, data);
            return data;
        } catch (err) {
            return null;
        }
    },

    /**
     * [L2 -> API] 獲取飛機照片
     */
    async getPhotos(icao24, registration) {
        const hasReg = registration && registration !== 'N/A';
        const cacheKey = hasReg ? `photos_${icao24}_${registration}` : `photos_${icao24}`;
        const cached = lruCache.get(cacheKey);
        if (cached) return cached;

        try {
            const regParam = hasReg ? `?reg=${encodeURIComponent(registration)}` : '';
            const res = await fetch(`/api/photos/${icao24}${regParam}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const results = await res.json();
            if (results.length > 0) lruCache.put(cacheKey, results);
            return results;
        } catch (err) {
            return [];
        }
    },

    /**
     * [L3 -> API] 獲取飛機形狀 SVG 清單
     */
    async getAircraftShapes() {
        try {
            const cached = await idb.getAll('shapes');
            if (cached && cached.length > 0) {
                logger.debug('CACHE', `L3 hit: ${cached.length} aircraft shapes`);
                return cached;
            }

            logger.info('FETCH', 'Aircraft shapes L3 cache miss — fetching from API');
            const res = await fetch('/api/aircraft-shapes');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const shapes = await res.json();
            idb.putAll('shapes', shapes).catch(err => logger.warn('CACHE', `L3 shapes write failed: ${err.message}`));
            return shapes;
        } catch (err) {
            logger.warn('FETCH', `Aircraft shapes load failed: ${err.message}`);
            return [];
        }
    }
};
