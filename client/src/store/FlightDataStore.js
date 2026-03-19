/**
 * FlightDataStore.js - 高效能 Zero-GC 低層資料倉儲
 */

// ─── [Internal] Haversine Distance Helper ────────────────────────────────────
function haversineDist(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

export class FlightDataStore {
    /**
     * @param {number} maxPlanes 支援的最大飛機總數 (預設 10,000)
     * @param {number} pointsPerPlane 每架飛機保留的軌跡點數 (預設 100)
     */
    constructor(maxPlanes = 10000, pointsPerPlane = 100) {
        this.maxPlanes = maxPlanes;
        this.pointsPerPlane = pointsPerPlane;
        this.floatsPerPoint = 5; // [Time, Lat, Lng, X, Y]

        // --- 核心記憶體佈局 (Memory Layout) ---
        // 總長度 = 10,000 * 100 * 4 = 4,000,000 Float32 (約 16MB)
        this.trackBuffer = new Float32Array(this.maxPlanes * this.pointsPerPlane * this.floatsPerPoint);

        // 指標管理 (Int32Array 速度最快且對 V8 友善)
        this.cursors = new Uint32Array(this.maxPlanes); // Write Heads (0 to 99)
        this.counts = new Uint32Array(this.maxPlanes);  // 目前寫入的有效點數 (0 to 100)

        // ICAO24 到 Slot 的靜態映射
        // 雖然建立映射會產生新 Key/Value，但飛機出現後就不再進行分配 (Stable States)
        this.planeToSlot = new Map();
        this.nextSlot = 0;
    }

    /**
     * [O(1)] 取得或動態分配飛機在 TypedArray 中的槽位
     */
    _getSlotIdx(icao24) {
        let slot = this.planeToSlot.get(icao24);
        if (slot === undefined) {
            slot = this.nextSlot;
            this.planeToSlot.set(icao24, slot);
            // 槽位循環利用 (LRU 簡化版)
            this.nextSlot = (this.nextSlot + 1) % this.maxPlanes;
            // 清理即將被覆寫的槽位元資料
            this.cursors[slot] = 0;
            this.counts[slot] = 0;
        }
        return slot;
    }

    /**
     * [O(1)] 加入新的軌跡點 (絕無記憶體分配)
     * @param {string} icao24 
     * @param {number} lat 緯度
     * @param {number} lng 經度
     * @param {number} x Canvas X 投影點 (快取)
     * @param {number} y Canvas Y 投影點 (快取)
     * @param {number} timestamp 
     */
    addTrackPoint(icao24, lat, lng, x, y, timestamp = null) {
        const slot = this._getSlotIdx(icao24);
        const count = this.counts[slot];
        const buffer = this.trackBuffer;
        const FPP = this.floatsPerPoint;
        const PPP = this.pointsPerPlane;
        const time = timestamp || Math.floor(Date.now() / 1000);

        // [Phase 8/10] 空間防護邏輯
        if (count > 0) {
            const cursor = this.cursors[slot];
            const lastIdx = (slot * PPP + ((cursor - 1 + PPP) % PPP)) * FPP;
            
            // 規則 0: 時間戳查重
            if (buffer[lastIdx] === time) return;

            const dist = haversineDist(buffer[lastIdx + 1], buffer[lastIdx + 2], lat, lng);

            // 規則 1: 去重 (距離 < 50m 則拋棄)
            if (dist < 50) return;

            // 規則 2: 斷點 (跳變 > 500km 則重置軌跡，防止異常連線)
            if (dist > 500000) {
                this.clearTrack(icao24);
                return;
            }
        }

        const cursor = this.cursors[slot];
        const baseIdx = (slot * PPP + cursor) * FPP;

        buffer[baseIdx] = time;
        buffer[baseIdx + 1] = lat;
        buffer[baseIdx + 2] = lng;
        buffer[baseIdx + 3] = x;
        buffer[baseIdx + 4] = y;

        // 環形指標遞增邏輯
        this.cursors[slot] = (cursor + 1) % PPP;

        // 記錄有效點數
        if (this.counts[slot] < PPP) {
            this.counts[slot]++;
        }
    }

    /**
     * [O(N)] 取得歷史軌跡點 (按時間從舊到新)
     * 透過 Callback 機制達成 Zero-Allocation 讀取，不產生中間過渡陣列
     * 
     * @param {string} icao24 
     * @param {Function} callback (time, lat, lng, x, y) => void
     */
    getTrackPoints(icao24, callback) {
        const slot = this.planeToSlot.get(icao24);
        if (slot === undefined) return;

        const count = this.counts[slot];
        const cursor = this.cursors[slot];
        const PPP = this.pointsPerPlane;
        const FPP = this.floatsPerPoint;
        const baseOffset = slot * PPP * FPP;
        const buffer = this.trackBuffer;

        const startReadIdx = count === PPP ? cursor : 0;

        for (let i = 0; i < count; i++) {
            const ringIdx = (startReadIdx + i) % PPP;
            const idx = baseOffset + (ringIdx * FPP);

            callback(
                buffer[idx],     // time
                buffer[idx + 1], // lat
                buffer[idx + 2], // lng
                buffer[idx + 3], // x
                buffer[idx + 4]  // y
            );
        }
    }

    /**
     * [O(M*N)] 批次迭代所有軌跡 (用於 Canvas 批次渲染)
     * @param {Function} callback (icao24, getPointsFn) => void
     */
    forEachTrack(callback) {
        for (const [icao24, slot] of this.planeToSlot) {
            const count = this.counts[slot];
            if (count < 2) continue;

            // 傳遞一個閉包，讓渲染器決定如何讀取點
            callback(icao24, (pointCb) => {
                this.getTrackPoints(icao24, (time, lat, lng, x, y) => {
                    pointCb(lat, lng, x, y); // Skip time for legacy renderers if needed
                });
            });
        }
    }

    /**
     * 批次更新所有點的 X/Y 快取 (例如地圖縮放或平移時調用)
     * 使用 Out-Parameter 模式，徹底免除對象分配
     */
    updateProjectionCache(projectorFn) {
        const buffer = this.trackBuffer;
        const PPP = this.pointsPerPlane;
        const FPP = this.floatsPerPoint;

        for (const [icao24, slot] of this.planeToSlot) {
            const count = this.counts[slot];
            const baseOffset = slot * PPP * FPP;

            for (let i = 0; i < count; i++) {
                const idx = baseOffset + (i * FPP);
                // buffer[idx] is time, skip it
                const proj = projectorFn(buffer[idx + 1], buffer[idx + 2]);
                buffer[idx + 3] = proj.x;
                buffer[idx + 4] = proj.y;
            }
        }
    }

    /**
     * [O(1)] 清理指定飛機的軌跡資料 (GC)
     */
    clearTrack(icao24) {
        const slot = this.planeToSlot.get(icao24);
        if (slot !== undefined) {
            this.cursors[slot] = 0;
            this.counts[slot] = 0;
            this.planeToSlot.delete(icao24);
        }
    }
}

// 實例化全域單例
export const trackStore = new FlightDataStore();
