/**
 * @file staticOsintCache.js
 * @description 擁有「全域保險箱」機制的靜態情報快取服務，解決 React 狀態覆蓋遺失資料的問題。
 */

const dbCache = {};
const pendingFetches = {};

/**
 * 【全域保險箱】：即便 React 重新獲取 Live Data 並覆蓋飛機物件，
 * 這裡的資料仍會永久保留，供 Canvas 渲染時動態合併。
 */
const resolvedPlanes = {};
let resolvedCount = 0;
const MAX_RESOLVED = 5000;

/**
 * 根據 hex 碼補充飛機細節（Typecode & Registration）
 * @param {string} hex 飛機的 ICAO24 16進制碼
 */
export async function enrichPlaneDetails(hex) {
    if (!hex || hex.length < 2) return null;
    const hexKey = hex.toLowerCase();
    const prefix = hexKey.substring(0, 2);

    // 1. 等待進行中的請求(同 prefix 去重複)
    if (pendingFetches[prefix]) {
        await pendingFetches[prefix];
    }

    // 2. 若無快取，發起請求
    if (!dbCache[prefix]) {
        pendingFetches[prefix] = fetch(`/api/adsb-static/${prefix}`)
            .then(res => res.ok ? res.json() : {})
            .then(data => { dbCache[prefix] = data; })
            .catch(() => { dbCache[prefix] = {}; })
            .finally(() => { delete pendingFetches[prefix]; });
        await pendingFetches[prefix];
    }

    // 【關鍵修復】：支援 Dictionary 物件, .aircraft 陣列, 或 直接陣列
    const data = dbCache[prefix] || {};
    let found = null;
    
    if (Array.isArray(data)) {
        found = data.find(a => (a.hex || '').toLowerCase() === hexKey);
    } else if (data.aircraft && Array.isArray(data.aircraft)) {
        // [v13.5] User-requested Array Search
        found = data.aircraft.find(a => (a.hex || '').toLowerCase() === hexKey);
    } else {
        // [Fallback] Classic Dictionary O(1) Lookup
        found = data[hexKey];
    }
    
    if (found) {
        // [v13.5] Memory Safety: Limit cache size to 5000 planes
        if (!resolvedPlanes[hexKey]) {
            if (resolvedCount >= MAX_RESOLVED) {
                Object.keys(resolvedPlanes).forEach(k => delete resolvedPlanes[k]);
                resolvedCount = 0;
            }
            resolvedCount++;
        }
        resolvedPlanes[hexKey] = {
            typecode: (found.t || found.type || found.typecode || '').toUpperCase(),
            registration: (found.r || found.registration || '').toUpperCase()
        };
        return resolvedPlanes[hexKey];
    }

    return null;
}

/**
 * 【同步讀取】：供 MapView.jsx 在 animate 迴圈中 0 延遲獲取資料
 */
export function getEnrichedData(hex) {
    if (!hex) return null;
    return resolvedPlanes[hex.toLowerCase()] || null;
}
