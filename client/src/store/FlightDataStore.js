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
     * @param {number} maxPlanes 支援的最大飛機總數
     * @param {number} backgroundPoints 每架背景飛機保留的點數 (預設 200)
     * @param {number} highResPoints 選中飛機保留的點數 (預設 10000)
     */
    constructor(maxPlanes = 10000, backgroundPoints = 2000, highResPoints = 20000) {
        this.maxPlanes = maxPlanes;
        this.backgroundPoints = backgroundPoints;
        this.highResPoints = highResPoints;
        this.floatsPerPoint = 5; // [Time, Lat, Lng, X, Y]

        // --- 核心記憶體佈局 ---
        // 1. 背景緩衝區 (所有飛機)
        this.trackBuffer = new Float32Array(this.maxPlanes * this.backgroundPoints * this.floatsPerPoint);
        this.cursors = new Uint32Array(this.maxPlanes); 
        this.counts = new Uint32Array(this.maxPlanes);

        // 2. 高解析度緩衝區 (僅限目前選中的飛機)
        this.highResIcao24 = null;
        this.highResBuffer = new Float32Array(this.highResPoints * this.floatsPerPoint);
        this.highResCursor = 0;
        this.highResCount = 0;

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
        const BGP = this.backgroundPoints;
        const time = timestamp || Math.floor(Date.now() / 1000);

        // 1. [Background Layer] 
        let skipBackground = false;
        if (count > 0) {
            const cursor = this.cursors[slot];
            const lastIdx = (slot * BGP + ((cursor - 1 + BGP) % BGP)) * FPP;
            if (buffer[lastIdx] === time) skipBackground = true;
            else {
                const dist = haversineDist(buffer[lastIdx + 1], buffer[lastIdx + 2], lat, lng);
                if (dist < 50) skipBackground = true;
                if (dist > 500000) { this.clearTrack(icao24); return; }
            }
        }

        if (!skipBackground) {
            const cursor = this.cursors[slot];
            const baseIdx = (slot * BGP + cursor) * FPP;
            buffer[baseIdx] = time;
            buffer[baseIdx + 1] = lat;
            buffer[baseIdx + 2] = lng;
            buffer[baseIdx + 3] = x;
            buffer[baseIdx + 4] = y;
            this.cursors[slot] = (cursor + 1) % BGP;
            if (this.counts[slot] < BGP) this.counts[slot]++;
        }

        // 2. [High-Res Layer] (Specialized for Selected Plane)
        if (this.highResIcao24 === icao24) {
            // Deduplicate similarly
            if (this.highResCount > 0) {
                const lastIdx = ((this.highResCursor - 1 + this.highResPoints) % this.highResPoints) * FPP;
                if (this.highResBuffer[lastIdx] === time) return;
            }
            
            const hIdx = this.highResCursor * FPP;
            this.highResBuffer[hIdx] = time;
            this.highResBuffer[hIdx + 1] = lat;
            this.highResBuffer[hIdx + 2] = lng;
            this.highResBuffer[hIdx + 3] = x;
            this.highResBuffer[hIdx + 4] = y;
            
            this.highResCursor = (this.highResCursor + 1) % this.highResPoints;
            if (this.highResCount < this.highResPoints) this.highResCount++;
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
        // High-Res Priority
        if (this.highResIcao24 === icao24 && this.highResCount > 0) {
            const count = this.highResCount;
            const cursor = this.highResCursor;
            const PPP = this.highResPoints;
            const FPP = this.floatsPerPoint;
            const startReadIdx = count === PPP ? cursor : 0;
            const buffer = this.highResBuffer;

            for (let i = 0; i < count; i++) {
                const ringIdx = (startReadIdx + i) % PPP;
                const idx = ringIdx * FPP;
                callback(buffer[idx], buffer[idx + 1], buffer[idx + 2], buffer[idx + 3], buffer[idx + 4]);
            }
            return;
        }

        // Background Fallback
        const slot = this.planeToSlot.get(icao24);
        if (slot === undefined) return;

        const count = this.counts[slot];
        const cursor = this.cursors[slot];
        const BGP = this.backgroundPoints;
        const FPP = this.floatsPerPoint;
        const baseOffset = slot * BGP * FPP;
        const buffer = this.trackBuffer;

        const startReadIdx = count === BGP ? cursor : 0;

        for (let i = 0; i < count; i++) {
            const ringIdx = (startReadIdx + i) % BGP;
            const idx = baseOffset + (ringIdx * FPP);
            callback(buffer[idx], buffer[idx + 1], buffer[idx + 2], buffer[idx + 3], buffer[idx + 4]);
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
        const BGP = this.backgroundPoints;
        const FPP = this.floatsPerPoint;

        // 1. Update Background Buffer
        for (const [icao24, slot] of this.planeToSlot) {
            const count = this.counts[slot];
            const baseOffset = slot * BGP * FPP;
            for (let i = 0; i < count; i++) {
                const idx = baseOffset + (i * FPP);
                const proj = projectorFn(this.trackBuffer[idx + 1], this.trackBuffer[idx + 2]);
                this.trackBuffer[idx + 3] = proj.x;
                this.trackBuffer[idx + 4] = proj.y;
            }
        }

        // 2. Update High-Res Buffer
        if (this.highResIcao24 && this.highResCount > 0) {
            for (let i = 0; i < this.highResCount; i++) {
                const idx = i * FPP;
                const proj = projectorFn(this.highResBuffer[idx + 1], this.highResBuffer[idx + 2]);
                this.highResBuffer[idx + 3] = proj.x;
                this.highResBuffer[idx + 4] = proj.y;
            }
        }
    }

    /**
     * [v11.0] High-Res Buffer Management
     * When a plane is selected, we migrate it to the expanded buffer.
     */
    setSelected(icao24) {
        if (this.highResIcao24 === icao24) return;

        // Clear existing high-res buffer
        this.highResBuffer.fill(0);
        this.highResCursor = 0;
        this.highResCount = 0;
        this.highResIcao24 = icao24;

        if (icao24) {
            // Migrate current background points to high-res buffer as a starting point
            const slot = this.planeToSlot.get(icao24);
            if (slot !== undefined) {
                this.getTrackPoints(icao24, (time, lat, lng, x, y) => {
                    const idx = this.highResCursor * this.floatsPerPoint;
                    this.highResBuffer[idx] = time;
                    this.highResBuffer[idx + 1] = lat;
                    this.highResBuffer[idx + 2] = lng;
                    this.highResBuffer[idx + 3] = x;
                    this.highResBuffer[idx + 4] = y;
                    this.highResCursor++;
                    this.highResCount++;
                });
            }
        }
    }

    /**
     * [O(1)] 清理指定飛機的軌跡資料 (GC)
     */
    clearTrack(icao24) {
        if (this.highResIcao24 === icao24) {
            this.highResBuffer.fill(0);
            this.highResCursor = 0;
            this.highResCount = 0;
        }

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
