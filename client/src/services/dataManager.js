/**
 * dataManager.js - AERO-SYNC 統一資料獲取門面 (Data Facade)
 * 管理 L1 (Store), L2 (LRU), L3 (IndexedDB) 與 外部 API 的調度
 */

import { idb, lruCache } from './storageManager';

export const dataManager = {
    /**
     * [L3 -> API] 獲取機場完整清單
     * 策略：先看 IndexedDB 是否有資料，若無才 Fetch，並非同步存入 DB。
     */
    async getAirports() {
        try {
            // 1. 嘗試從 IndexedDB 讀取
            const cachedAirports = await idb.getAll('airports');
            if (cachedAirports && cachedAirports.length > 5000) {
                console.log(`📦 [DataManager] L3 Cache Hit: ${cachedAirports.length} airports`);
                return cachedAirports;
            }

            // 2. 緩存失效或不存在，從 API 獲取
            console.log('🌐 [DataManager] L3 Cache Miss. Fetching from API...');
            const response = await fetch('/api/airports/list');
            if (!response.ok) throw new Error('Failed to fetch airports');

            const airports = await response.json();

            // 3. 非同步存入 L3，不阻塞回傳
            idb.putAll('airports', airports).catch(err => console.warn('L3 Update Failed:', err));

            return airports;
        } catch (error) {
            console.error('[DataManager] Airport loading error:', error);
            return [];
        }
    },

    /**
     * [L2 -> API] 獲取指定機場的 METAR 天氣
     * 策略：LRU 只要有且未過期就直接回傳，否則打 API 並回寫。
     */
    async getMetar(icao) {
        const cacheKey = `metar_${icao}`;

        // 1. 嘗試從 L2 LRU 讀取
        const cached = lruCache.get(cacheKey);
        if (cached) {
            console.log(`⚡ [DataManager] L2 Cache Hit (METAR): ${icao}`);
            return cached;
        }

        // 2. 打 API
        try {
            const response = await fetch(`/api/metar?icao=${icao}`);
            if (!response.ok) throw new Error('METAR API error');
            const data = await response.json();

            // 3. 存入 L2
            lruCache.put(cacheKey, data);
            return data;
        } catch (error) {
            console.warn(`[DataManager] METAR Fetch Failed for ${icao}:`, error.message);
            return { error: true, message: error.message };
        }
    },

    /**
     * [L2 -> API] 獲取航線推斷結果
     * 策略：本地空間推斷優先，失敗則嘗試外部 API 補水
     */
    async getRoute(icao24, callsign) {
        const cacheKey = `route_${icao24}`;
        const cached = lruCache.get(cacheKey);
        if (cached) return cached;

        try {
            // 1. 本地空間推斷引擎
            const response = await fetch(`/api/route/${icao24}`);
            if (!response.ok) throw new Error('Local Route API error');
            let data = await response.json();

            // 2. [Phase 10] 外部 API 補水 (Fallback)
            // 如果本地回傳 noData 且有呼號，嘗試打外部模擬端點 (或真實 AirLabs 端點)
            if ((!data || data.noData || !data.departureAirport) && callsign) {
                console.log(`🌐 [DataManager] Local inference failed for ${callsign}. Trying external fallback...`);
                // 模擬外部 API 呼叫 (此處對應後端整合好的補水端點)
                const extRes = await fetch(`/api/route/external?callsign=${callsign}`);
                if (extRes.ok) {
                    const extData = await extRes.json();
                    if (extData && extData.departureAirport) {
                        data = extData;
                    }
                }
            }

            lruCache.put(cacheKey, data);
            return data;
        } catch (err) {
            console.warn('[DataManager] Route resolution failed:', err);
            return null;
        }
    },

    /**
     * [L2 -> API] 獲取歷史軌跡
     * 策略：針對高頻點擊的飛機進行 1 分鐘短暫快取，避免重複打 API
     */
    async getTrack(icao24, lastContact) {
        const cacheKey = `track_${icao24}_${lastContact || 'live'}`;
        const cached = lruCache.get(cacheKey);
        if (cached) return cached;

        try {
            const timeParam = lastContact ? `&time=${lastContact}` : '';
            const res = await fetch(`/api/tracks?icao24=${icao24}${timeParam}`);
            if (!res.ok) throw new Error('Track API error');
            const data = await res.json();

            // 短暫快取 (60秒) 避免快速切換時重複請求
            lruCache.put(cacheKey, data);
            return data;
        } catch (err) {
            throw err;
        }
    },

    /**
     * [L2 -> API] 獲取飛機詳細 Meta 資料
     * 策略：使用 L2 快取 30 分鐘，避免重複查詢靜態資訊。
     */
    async getMetadata(icao24) {
        const cacheKey = `metadata_${icao24}`;
        const cached = lruCache.get(cacheKey);
        if (cached) return cached;

        try {
            const res = await fetch(`/api/metadata/${icao24}`);
            if (!res.ok) throw new Error('Metadata API error');
            const data = await res.json();

            lruCache.put(cacheKey, data);
            return data;
        } catch (err) {
            return { noData: true };
        }
    },

    /**
     * [L2 -> API] 獲取單一機場詳細資訊
     * 策略：針對特定航線的起降機場進行 L2 快取。
     */
    async getAirport(code) {
        if (!code || code === 'N/A') return null;
        const cacheKey = `airport_${code}`;
        const cached = lruCache.get(cacheKey);
        if (cached) return cached;

        try {
            const res = await fetch(`/api/airport/${code}`);
            if (!res.ok) throw new Error('Airport API error');
            const data = await res.json();

            lruCache.put(cacheKey, data);
            return data;
        } catch (err) {
            return null;
        }
    },

    /**
     * [L2 -> API] 獲取飛機照片 (透過後端代理 Planespotters.net)
     * 策略：使用 L2 快取，減少頻繁切換飛機時對第三方 API 的請求壓力。
     */
    async getPhotos(icao24, registration) {
        const cacheKey = `photos_${icao24 || registration}`;
        const cached = lruCache.get(cacheKey);
        if (cached) return cached;

        try {
            const regParam = registration && registration !== 'N/A' ? `?reg=${encodeURIComponent(registration)}` : '';
            const res = await fetch(`/api/photos/${icao24}${regParam}`);
            if (!res.ok) throw new Error('Photos API error');
            const results = await res.json();

            if (results.length > 0) {
                lruCache.put(cacheKey, results);
            }
            return results;
        } catch (err) {
            return [];
        }
    },

    /**
     * [L3 -> API] 獲取飛機形狀 SVG 清單 (AircraftShapesSVG)
     * 策略：永久存入 IndexedDB (shapes 幾乎不變)，APP 啟動時一次性讀取。
     */
    async getAircraftShapes() {
        try {
            // 1. 嘗試從 IndexedDB 讀取
            const cached = await idb.getAll('shapes');
            if (cached && cached.length > 0) {
                console.log(`📦 [DataManager] L3 Cache Hit: ${cached.length} aircraft shapes`);
                return cached;
            }

            // 2. 緩存不存在，從 API 獲取
            console.log('🌐 [DataManager] Fetching aircraft shapes from API...');
            const res = await fetch('/api/aircraft-shapes');
            if (!res.ok) throw new Error('Aircraft shapes API error');
            const shapes = await res.json();

            // 3. 非同步存入 L3
            idb.putAll('shapes', shapes).catch(err => console.warn('L3 Shapes Update Failed:', err));

            return shapes;
        } catch (err) {
            console.warn('[DataManager] Aircraft shapes load failed:', err.message);
            return [];
        }
    }
};
