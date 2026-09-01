import { useState, useRef, useCallback, useEffect } from 'react';
import { parseOpenSkyData, latLngToGlobalPixels } from '../utils/flightUtils';
import { trackStore } from '../store/FlightDataStore';
import { dataManager } from '../services/dataManager';
import { logger } from '../utils/logger';

// ── Haversine distance (km) for interpolation sanity check ──────────────────
function _hKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
              Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * 判斷新座標是否為不可能的跳躍（MLAT 噪音 / 資料凍結後暴跳）。
 * 若為跳躍，傳回 true → 呼叫端應 snap 而非插值。
 *
 * 閾值（與 trailSpline.js 一致）：
 *   - dist > 20km in < 120s
 *   - 或 implied speed > 1500 km/h AND dist > 3km
 */
function _isImpossibleJump(fromLat, fromLng, toLat, toLng, dtMs) {
    if (!fromLat || !toLat) return false;
    const dist = _hKm(fromLat, fromLng, toLat, toLng);
    if (dist < 0.05) return false; // < 50m，完全沒動，不是跳躍
    const dtSec = dtMs / 1000;
    if (dtSec <= 0) return dist > 20;
    const spdKph = (dist / dtSec) * 3600;
    return (dist > 20 && dtSec < 120) || (spdKph > 1500 && dist > 3 && dtSec < 120);
}

// ── Bearing-consistency check — second line of defense against reversals ───
// The backend already arbitrates conflicting position updates (server.js
// isPositionUpdateTrustworthy), but at global zoom with ~8,000 aircraft on
// screen simultaneously, even the small residual rate that gets past it
// (mostly genuine upstream MLAT noise from adsb.lol) produces a visible
// glitch somewhere on the map roughly once a second — which reads as "the
// same backward-snapping problem" even though the per-aircraft rate is now
// low. _isImpossibleJump only rejects absolute distance/speed outliers; it
// can't catch a small-magnitude update that reverses direction, which is
// exactly the "moves forward then snaps back" symptom. This catches that:
// if the new position's displacement bearing disagrees with the aircraft's
// own reported heading by more than ~120°, treat it as suspect and hold the
// current render position instead of interpolating toward it.
function _isBearingReversal(fromLat, fromLng, toLat, toLng, heading) {
    if (!fromLat || !toLat || typeof heading !== 'number') return false;
    const dist = _hKm(fromLat, fromLng, toLat, toLng);
    if (dist < 0.06) return false; // < 60m — bearing is too noisy to mean anything at this scale
    const toRad = d => d * Math.PI / 180;
    const y = Math.sin(toRad(toLng - fromLng)) * Math.cos(toRad(toLat));
    const x = Math.cos(toRad(fromLat)) * Math.sin(toRad(toLat)) -
              Math.sin(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.cos(toRad(toLng - fromLng));
    const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    const diff = Math.abs(bearing - heading) % 360;
    return (diff > 180 ? 360 - diff : diff) > 120;
}

/**
 * 飛行資料管理 Hook
 * - 定時從後端 /api/states 拉取全球飛機資料
 * - 測量 API 延遲
 * - 從 /api/stats 拉取 API 使用統計
 * - 管理 planesDict、flightHistory
 */
export function useFlightData(mapRef, options = {}) {
    const [planesDict, setPlanesDict] = useState({});
    const [planeCount, setPlaneCount] = useState(0);
    const [airCount, setAirCount] = useState(0);
    const [groundCount, setGroundCount] = useState(0);
    const [apiStatus, setApiStatus] = useState('INIT');
    const [apiStatusClass, setApiStatusClass] = useState('');
    const [apiErrorDetail, setApiErrorDetail] = useState('');
    const [latency, setLatency] = useState(null);
    const [lastUpdateTime, setLastUpdateTime] = useState(null);
    const [apiStats, setApiStats] = useState(null);
    const [throttleSeconds, setThrottleSeconds] = useState(60);

    const flightHistoryRef = useRef({});
    const isFetchingRef = useRef(false);
    const planesDictRef = useRef({});
    const apiStatusRef = useRef('INIT');
    const globalLastUpdateRef = useRef(0);
    const sessionIdRef = useRef(`s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const nextScheduledFetchRef = useRef(Date.now() + 60000);
    const workerRef = useRef(null);
    const usesWebSocketRef = useRef(false);
    // Callback set by App.jsx to receive live track point pushes
    const trackPointListenerRef = useRef(null);
    
    // [v4.3.6] Auto-Backfill Queue for Cold Starts
    const backfillQueueRef = useRef([]);
    const backfilledIcaosRef = useRef(new Set());
    const wsBatchCountRef = useRef(0); // [LOG] WS batch counter for throttled debug output

    // [Project AERO-SYNC] Zero-GC Projection Helper
    const sharedPointRef = useRef({ x: 0, y: 0 });

    // 保持 ref 和 state 同步
    useEffect(() => {
        planesDictRef.current = planesDict;
    }, [planesDict]);

    useEffect(() => {
        apiStatusRef.current = apiStatus;
    }, [apiStatus]);

    const fetchPlanes = useCallback(async (isAutoRefresh = false) => {
        // 如果 WebSocket 正在運作，則略過傳統輪詢
        if (usesWebSocketRef.current && isAutoRefresh) return;

        // 如果是正在抓取中，就跳過
        if (isFetchingRef.current) return;
        isFetchingRef.current = true;

        const startTime = performance.now();

        try {
            // [BBox Fetch] 動態只索取畫面範圍內的飛機
            let url = '/api/planes/bbox';

            // 加入 20% 安全邊界，讓 BBox 再稍微擴大一點，避免邊緣飛機突然消失
            if (mapRef && mapRef.current) {
                const bounds = mapRef.current.getBounds();
                const padLat = (bounds.getNorth() - bounds.getSouth()) * 0.2;
                const padLng = (bounds.getEast() - bounds.getWest()) * 0.2;

                url += `?lamin=${bounds.getSouth() - padLat}&lomin=${bounds.getWest() - padLng}&lamax=${bounds.getNorth() + padLat}&lomax=${bounds.getEast() + padLng}`;
            } else {
                // 如果還沒有地圖實例 (剛載入)，給一個預設的寬廣範圍 (例如整個亞洲)
                url += `?lamin=-10&lomin=90&lamax=50&lomax=150`;
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);

            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);

            const elapsed = Math.round(performance.now() - startTime);
            setLatency(elapsed);

            if (!response.ok) {
                let errorMsg = `Error ${response.status} (${response.statusText})`;

                try {
                    const clonedRes = response.clone();
                    const errData = await clonedRes.json();
                    if (errData.stats) {
                        setApiStats(errData.stats);
                    }
                } catch (e) { }

                try {
                    const text = await response.text();
                    if (text) errorMsg = `Error ${response.status}: ${text.substring(0, 100)}`;
                } catch (e) { }

                if (response.status === 429) {
                    setApiStatus(`RATE LIMITED`);
                    setApiStatusClass('stat-warning');
                    throw new Error('429 Rate Limited (Daily limits exhausted)');
                }
                throw new Error(errorMsg);
            }

            const data = await response.json();

            // 同步提取後端綁定的 API 狀態，實現全裝置 100% 同步
            if (data.stats) {
                setApiStats(data.stats);
            }

            // [v2.3.10] 移除此處的計時器重置，改由 useEffect 或自動週期控制
            // setThrottleSeconds(intervalDelay); 

            const parsedPlanes = (data.states || []).map(p => {
                return {
                    icao24: p.icao24,
                    data: {
                        ...p,
                        callsign: p.callsign || p.icao24?.toUpperCase() || '',
                        registration: 'N/A', // populated later from metadata
                        aircraftType: 'Unknown',
                        lastSeenTime: data.globalLastUpdate || Math.floor(Date.now() / 1000)
                    }
                };
            });

            if (data.globalLastUpdate) {
                globalLastUpdateRef.current = data.globalLastUpdate;
            }

            if (parsedPlanes.length > 0) {
                processPlaneData(parsedPlanes);
                setApiStatus(data.stale ? 'STALE CACHE' : 'OpenSky');
                setApiStatusClass(data.stale ? 'stat-warning' : '');
                setApiErrorDetail('');
                setLastUpdateTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
                logger.info('FETCH', `✅ Poll OK — ${parsedPlanes.length} planes | ${elapsed}ms${data.stale ? ' [STALE]' : ''}`);
            } else {
                setApiStatus('NO DATA');
                setApiStatusClass('stat-warning');
                setApiErrorDetail('API reached successfully but returned 0 planes.');
                logger.warn('FETCH', `⚠️ Poll returned 0 planes | ${elapsed}ms`);
            }

            // 如果是自動刷新觸發的，就設定下一預約更新時間並排程
            if (isAutoRefresh) {
                const interval = (data.recommendedInterval || 20) * 1000;
                nextScheduledFetchRef.current = Date.now() + interval;
                setThrottleSeconds(Math.round(interval / 1000));
                setTimeout(() => {
                    fetchPlanes(true);
                }, interval);
            }

            isFetchingRef.current = false;
            return; // 成功結束
        } catch (error) {
            logger.error('FETCH', `❌ Poll failed — ${error.message}`);
            setApiStatusClass('stat-error');

            // 失敗後同樣釋放鎖
            isFetchingRef.current = false;
            if (isAutoRefresh) {
                setTimeout(() => {
                    fetchPlanes(true);
                }, 5000);
            }
            return;
        }
    }, []);

    // 處理飛機資料 (非破壞性合併)
    const processPlaneData = useCallback((planes) => {
        setPlanesDict((prev) => {
            const history = flightHistoryRef.current;
            const next = { ...prev };

            planes.forEach(({ icao24, data: pData }) => {
                // [Project AERO-SYNC] 將歷史資料存入 Zero-GC DataStore
                if (mapRef && mapRef.current) {
                    const zoom = mapRef.current.getZoom();
                    const globalPt = latLngToGlobalPixels(pData.lat, pData.lng, zoom, sharedPointRef.current);
                    const timestamp = pData.lastSeenTime; 
                    trackStore.addTrackPoint(icao24, pData.lat, pData.lng, globalPt.x, globalPt.y, timestamp);
                }

                if (!next[icao24]) {
                    const zoom = mapRef.current ? mapRef.current.getZoom() : 5;
                    const globalPt = latLngToGlobalPixels(pData.lat, pData.lng, zoom, sharedPointRef.current);
                    const now0 = Date.now();

                    next[icao24] = {
                        ...pData,
                        isDirty: true,
                        lastCallsign: '',
                        // Snapshot Interpolation — first appearance: start and end at same point
                        _interpFromLat: pData.lat,
                        _interpFromLng: pData.lng,
                        _interpToLat:   pData.lat,
                        _interpToLng:   pData.lng,
                        _interpStartMs: now0,
                        _interpDurMs:   8000,
                        _dataArrivedAt: now0,
                        renderLat: pData.lat,
                        renderLng: pData.lng,
                        globalX: globalPt.x,
                        globalY: globalPt.y
                    };

                    // [v4.4.0] Trigger Enhanced Auto-Backfill
                    if (!backfilledIcaosRef.current.has(icao24) && !pData.isBackfilling) {
                        next[icao24].isBackfilling = true;
                        backfillQueueRef.current.push(icao24);
                    }
                } else {
                    const existing = next[icao24];
                    const isDirty =
                        existing.heading !== pData.heading ||
                        existing.altitude !== pData.altitude ||
                        existing.callsign !== pData.callsign ||
                        existing.onGround !== pData.onGround ||
                        existing.isEmergency !== pData.isEmergency;

                    // [Project AERO-SYNC] 計算飛機目前位置的全域座標
                    const zoom = mapRef.current ? mapRef.current.getZoom() : 5;
                    const globalPt = latLngToGlobalPixels(pData.lat, pData.lng, zoom, sharedPointRef.current);

                    // [Snapshot Interpolation v2.0 — Buffered]
                    // [Snapshot Interpolation v2.1 — Buffered + Jump Guard]
                    // Always interpolate between two confirmed positions.
                    // Impossible jumps (MLAT noise / stale-then-teleport) → snap directly.
                    const now = Date.now();
                    const rawDurMs = now - (existing._dataArrivedAt ?? now);
                    const observedDurMs  = Math.max(3000, Math.min(30000, rawDurMs));
                    // Long idle: always snap + discard stale trail.
                    // [2026-09-01] Was `> 60000` — the EXACT same value as
                    // trackIngest.js's own "meaningful change" heartbeat
                    // guarantee (services/trackIngest.js: forces a write at
                    // least every 60s even with zero movement). A threshold
                    // equal to a guaranteed max gap has zero margin — any
                    // real-world timing jitter (a poll running a few hundred
                    // ms late, GC pause, network latency) pushes the actual
                    // gap slightly past 60000ms during completely normal
                    // operation, wiping a healthy trail for no reason. Raised
                    // to 90000 to match PLANE_TTL_MS (broadcastEngine.js) —
                    // the same horizon already used as "this plane is
                    // genuinely gone" elsewhere in the system.
                    const isStaleAfterIdle = rawDurMs > 90000;

                    // Current render position is the most accurate "from" reference
                    const curRenderLat = existing.renderLat ?? existing._interpToLat ?? existing._emaLat ?? existing.lat;
                    const curRenderLng = existing.renderLng ?? existing._interpToLng ?? existing._emaLng ?? existing.lng;

                    // [v2.2 — parity with the WS path's EMA + bearing-reversal guards]
                    // This bbox-polling path is the fallback when the WebSocket drops —
                    // it used to apply only the absolute jump guard, missing the EMA
                    // noise smoothing and bearing-reversal rejection the WS path has had
                    // for a while. A user who fell back to polling lost both defenses at
                    // once: the same MLAT jitter that's invisible on WS produced visible
                    // jitter/reversal glitches here. Bearing check runs on the raw
                    // incoming position, before EMA, so a rejected sample never poisons
                    // the EMA's running state for the next (good) sample.
                    const bearingRejected = !isStaleAfterIdle && !pData.onGround &&
                        _isBearingReversal(curRenderLat, curRenderLng, pData.lat, pData.lng, pData.heading);

                    const EMA_ALPHA = 0.72;
                    let emaLat, emaLng;
                    if (bearingRejected) {
                        emaLat = existing._emaLat ?? curRenderLat;
                        emaLng = existing._emaLng ?? curRenderLng;
                    } else if (existing._emaLat != null) {
                        emaLat = EMA_ALPHA * pData.lat + (1 - EMA_ALPHA) * existing._emaLat;
                        emaLng = EMA_ALPHA * pData.lng + (1 - EMA_ALPHA) * existing._emaLng;
                    } else {
                        emaLat = pData.lat;
                        emaLng = pData.lng;
                    }

                    // Long idle or impossible jump → snap to new position, reset interpolation
                    if (isStaleAfterIdle || (!bearingRejected && _isImpossibleJump(curRenderLat, curRenderLng, pData.lat, pData.lng, observedDurMs))) {
                        if (isStaleAfterIdle) trackStore.clearTrack(icao24);
                        next[icao24] = {
                            ...existing,
                            ...pData,
                            isDirty,
                            _emaLat: emaLat,
                            _emaLng: emaLng,
                            _interpFromLat: emaLat,
                            _interpFromLng: emaLng,
                            _interpToLat:   emaLat,
                            _interpToLng:   emaLng,
                            _interpStartMs: now,
                            _interpDurMs:   observedDurMs,
                            _pendingLat:    undefined,
                            _pendingLng:    undefined,
                            _pendingDurMs:  undefined,
                            _dataArrivedAt: now,
                            renderLat: emaLat,
                            renderLng: emaLng,
                            globalX: globalPt.x,
                            globalY: globalPt.y
                        };
                        return; // skip normal interp update below
                    }

                    // Lerp from wherever the plane is actually rendered right now, not
                    // from the previous segment's target. If new data arrives before the
                    // prior lerp finished (bursty network, server catch-up), curRenderLat
                    // reflects the true on-screen position; _interpToLat would still be
                    // the old, not-yet-reached target and cause a visible snap-back.
                    const interpUpdate = {
                        _emaLat: emaLat,
                        _emaLng: emaLng,
                        _interpFromLat: curRenderLat,
                        _interpFromLng: curRenderLng,
                        _interpToLat:   emaLat,
                        _interpToLng:   emaLng,
                        _interpStartMs: now,
                        _interpDurMs:   observedDurMs,
                        _pendingLat:    undefined,
                        _pendingLng:    undefined,
                        _pendingDurMs:  undefined,
                    };

                    next[icao24] = {
                        ...existing,
                        ...pData,
                        isDirty,
                        ...interpUpdate,
                        _dataArrivedAt: now,
                        renderLat: existing.renderLat ?? existing.lat,
                        renderLng: existing.renderLng ?? existing.lng,
                        globalX: globalPt.x,
                        globalY: globalPt.y
                    };
                }
            });

            // 清理機制：不再根據這次 BBox 結果刪除，而是根據「過期時間」
            // 只有當飛機最後一次在後端全球快取出現的時間比當前最新的全球刷新時間早超過門檻，才視為消失
            // [2026-09-01] 門檻原本是 60 秒——比後端自己認定「這架飛機真的消失」
            // 的權威門檻 PLANE_TTL_MS（services/broadcastEngine.js，90 秒）還短。
            // 代表前端會比後端更早放棄一架飛機：後端還在追蹤、隨時可能送出新資料，
            // 前端卻已經把它從 planesDict 刪掉，下一筆更新一到又要重新當成「新飛機」
            // 冒出來——尤其在今天一直遇到的 adsb.lol/OpenSky 間歇性斷線期間，這個
            // 落差會更容易被撞到。改成跟後端一致的 90 秒，前端永遠不會比後端更早放棄。
            const globalSnapshotTime = globalLastUpdateRef.current || Math.floor(Date.now() / 1000);
            Object.keys(next).forEach((id) => {
                const p = next[id];
                // 如果這架飛機太久沒出現在全球快取中，則清理
                if (p.lastSeenTime && globalSnapshotTime - p.lastSeenTime > 90) {
                    delete next[id];
                    delete history[id];
                }
            });

            // [OPT 3.3] 限制記憶體內採蹤的飛機檔案數，防止長時間運行記憶體漉漏
            const MAX_HISTORY_ENTRIES = 3000;
            const historyKeys = Object.keys(history);
            if (historyKeys.length > MAX_HISTORY_ENTRIES) {
                // 清理超界的最舊條目
                const globalSnapshotTime2 = globalLastUpdateRef.current || Math.floor(Date.now() / 1000);
                for (const hid of historyKeys) {
                    if (!next[hid]) {
                        delete history[hid];
                    }
                }
            }

            // [OPT 2.3] 合併多個 setState，從 updater 回傳後再分手更新計數
            return next;
        });
    }, []);

    // [v3.1] Reliable dynamic tally of aircraft states
    useEffect(() => {
        const list = Object.values(planesDict);
        let air = 0;
        let ground = 0;
        for (let i = 0; i < list.length; i++) {
            if (list[i].onGround) ground++;
            else air++;
        }
        setPlaneCount(list.length);
        setAirCount(air);
        setGroundCount(ground);
    }, [planesDict]);

    // Haversine distance (meters)
    const getDistance = (lat1, lon1, lat2, lon2) => {
        const R = 6371e3;
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    };

    const fetchTrack = useCallback(async (icao24, lastContact, forceRefresh = false) => {
        try {
            const data = await dataManager.getTrack(icao24, lastContact, forceRefresh);

            if (data.path && data.path.length > 0) {
                // [v11.0] Stop discarding 'future' points from backend. Backend truth is absolute.
                const validPoints = data.path
                    .filter((p) => p[1] && p[2])
                    .sort((a, b) => a[0] - b[0]);

                // [v4.7.0] 極簡化前端邏輯：信任後端經過 30min GAP 與 0,0 清洗後的純淨陣列
                return validPoints.map((p) => [
                    p[0],  // time (UNIX)
                    p[1],  // lat
                    p[2],  // lng
                    p[3],  // altitude (meters)
                    p[4],  // true_track (heading)
                    p[5]   // velocity
                ]);
            }
        } catch (e) {
            logger.warn('DATA', `Track fetch failed, using local history: ${e.message}`);
        }

        // Fallback: 本地歷史 — format: [time, lat, lng, onGround]
        const history = flightHistoryRef.current[icao24];
        if (!history || history.length < 2) return [];

        let latestSegmentStartIdx = 0;
        for (let i = 1; i < history.length; i++) {
            const timeDiff = history[i][0] - history[i - 1][0];
            const wasOnGround = history[i - 1][3] === true;
            const isOnGround = history[i][3] === true;
            const dist = getDistance(history[i - 1][1], history[i - 1][2], history[i][1], history[i][2]);

            if ((isOnGround && history[history.length - 1][3] === true) ||
                (timeDiff > 1800 && (wasOnGround || isOnGround)) ||
                (timeDiff > 30 && (dist / timeDiff) > 400)) {
                latestSegmentStartIdx = i;
            }
        }
        const sortedHistory = [...history].sort((a, b) => a[0] - b[0]);

        // Pad to the same 6-field tuple shape as the API path above, so
        // callers don't need to branch on which source the track came from.
        return sortedHistory.slice(latestSegmentStartIdx).map((p) => [
            p[0], p[1], p[2], null, null, null
        ]);
    }, []);

    // [v4.4.0] Enhanced Priority Backfill Processor
    useEffect(() => {
        const processor = setInterval(async () => {
            if (backfillQueueRef.current.length === 0) return;

            // Priority Logic: Selected aircraft > Viewport center > Others
            // Find selected aircraft in queue if any
            const urlParams = new URLSearchParams(window.location.search);
            const selectedIcao = urlParams.get('icao');
            
            let targetIdx = backfillQueueRef.current.findIndex(id => id === selectedIcao);
            if (targetIdx === -1) {
                // If no selected, just take the first one (or we could sort by viewport distance)
                targetIdx = 0;
            }

            const icao24 = backfillQueueRef.current.splice(targetIdx, 1)[0];
            if (!icao24 || backfilledIcaosRef.current.has(icao24)) return;
            
            backfilledIcaosRef.current.add(icao24);

            try {
                const path = await fetchTrack(icao24);
                if (path && path.length > 0) {
                    logger.debug('DATA', `📍 Backfill OK ${icao24} — ${path.length} track points`);
                    // [v4.5.1] Seamless Merge & Deduplication
                    // 1. Get current points from store (Live Points)
                    const livePoints = [];
                    trackStore.getTrackPoints(icao24, (time, lat, lng, x, y) => {
                        livePoints.push([time, lat, lng, x, y]);
                    });

                    // [v11.0] AEROSTRAT Zero-Truncation Merge Logic
                    // Use a Map (Time → Point) for O(1) deduplication and high-precision override
                    const mergedMap = new Map();
                    
                    // 1. Write Backfilled Historical Points (OpenSky)
                    path.map(p => [p[0], p[1], p[2]]).forEach(pt => mergedMap.set(pt[0], pt));
                    
                    // 2. Write Live Local Points (Favoring Local precision/availability)
                    livePoints.forEach(pt => mergedMap.set(pt[0], pt));
                    
                    // 3. Convert back to array and Sort strictly by time
                    const merged = Array.from(mergedMap.values()).sort((a, b) => a[0] - b[0]);

                    // 3. Re-inject fully merged track into store
                    trackStore.clearTrack(icao24);
                    // [v11.0] AEROSTRAT Ultra-Long Trajectory Support: Ensure we project at current zoom
                    const zoom = mapRef.current ? mapRef.current.getZoom() : 10;
                    merged.forEach(pt => {
                        const [time, lat, lng] = pt;
                        const globalPt = latLngToGlobalPixels(lat, lng, zoom, sharedPointRef.current);
                        trackStore.addTrackPoint(icao24, lat, lng, globalPt.x, globalPt.y, time);
                    });
                    
                    // [v4.6.0] Forced State Update: Break Reference and Force UI Redraw
                    setPlanesDict(prev => {
                        const currentPlane = prev[icao24];
                        if (currentPlane) {
                            // Create a brand new plane object with a new 'track' property if needed
                            // and a 'forceUpdate' timestamp to ensure Mapbox/React detect the change.
                            return {
                                ...prev,
                                [icao24]: {
                                    ...currentPlane,
                                    isBackfilling: false,
                                    isDirty: true
                                }
                            };
                        }
                        return prev;
                    });
                }
            } catch (e) {
                logger.error('DATA', `Backfill merge error for ${icao24}: ${e.message}`);
            }
        }, 500); // 500ms per aircraft

        return () => clearInterval(processor);
    }, [fetchTrack]);

    // 定時更新飛機    // 初次載入驅動迴圈
    useEffect(() => {
        if (!isFetchingRef.current) {
            fetchPlanes(true); // 使用 true 啟動定時自動更新
        }

        // Timer countdown sync for UI (不負責 fetch，只負責反映距離下一個 nextScheduledFetchRef 的剩餘時間)
        const uiTimer = setInterval(() => {
            if (usesWebSocketRef.current) {
                setThrottleSeconds(0); // WebSocket is realtime
                return;
            }
            const remaining = Math.max(0, Math.round((nextScheduledFetchRef.current - Date.now()) / 1000));
            setThrottleSeconds(remaining);
        }, 1000);

        return () => clearInterval(uiTimer);
    }, [fetchPlanes]);

    const syncViewport = useCallback((bbox) => {
        if (workerRef.current) {
            workerRef.current.postMessage({ type: 'SET_VIEWPORT', payload: bbox });
        }
        // [v4.3.0] Heartbeat to server for Engine B (Sniper)
        fetch('/api/viewport', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...bbox, sessionId: sessionIdRef.current })
        }).catch(() => { }); // Silent fail
    }, []);

    // [Project AERO-SYNC] Initialize WebWorker for WebSocket Binary Stream
    useEffect(() => {
        // [v7.0] Off-Thread Flight Data Engine — heavy parsing + state consolidation in Worker
        const worker = new Worker(new URL('../workers/flightWorker.js', import.meta.url), { type: 'module' });
        workerRef.current = worker;

        worker.onmessage = (event) => {
            const { type, payload } = event.data;
            if (type === 'WS_CONNECTED') {
                logger.info('WS', '✅ WebSocket Connected — AERO-SYNC active');
                setApiStatus('AERO-SYNC (WS)');
                setApiStatusClass('stat-success');
                usesWebSocketRef.current = true;
                setApiErrorDetail('');
            } else if (type === 'WS_DISCONNECTED' || type === 'WS_ERROR') {
                logger.warn('WS', `⚠️ WebSocket ${type === 'WS_ERROR' ? 'Error' : 'Disconnected'} — falling back to polling`);
                usesWebSocketRef.current = false;
                setApiStatus('FALLBACK (Polling)');
                setApiStatusClass('stat-warning');
                fetchPlanes(false);
            } else if (type === 'PLANES_BATCH') {
                // Worker has already done: msgpack decode → array→object → state consolidation → debounce
                // Main thread only: projection + trackStore + React setState (minimal work)
                options.onWsData?.();
                const { changed, removed = [], globalTime } = payload;
                globalLastUpdateRef.current = globalTime;
                setLastUpdateTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
                wsBatchCountRef.current = (wsBatchCountRef.current || 0) + 1;
                if (wsBatchCountRef.current % 30 === 1) {
                    logger.debug('WS', `📡 WS Batch #${wsBatchCountRef.current} — changed: ${Object.keys(changed).length}, removed: ${removed.length}`);
                }

                const map = mapRef.current;
                const zoom = map ? map.getZoom() : 5;
                const now = Date.now();

                // Apply pre-assembled plane objects (no array destructuring needed)
                const changedIds = Object.keys(changed);
                for (let i = 0; i < changedIds.length; i++) {
                    const id = changedIds[i];
                    const wp = changed[id]; // worker-assembled plane object

                    // Projection + track store (requires main-thread map reference)
                    const globalPt = latLngToGlobalPixels(wp.lat, wp.lng, zoom, sharedPointRef.current);
                    trackStore.addTrackPoint(id, wp.lat, wp.lng, globalPt.x, globalPt.y);

                    // Merge into mutable ref (preserve render state from animate loop)
                    let p = planesDictRef.current[id];
                    if (!p) {
                        p = { icao24: id };
                        planesDictRef.current[id] = p;
                    }

                    p.lat = wp.lat;
                    p.lng = wp.lng;
                    p.heading = wp.heading;
                    p.altitude = wp.altitude;
                    p.velocity = wp.velocity;
                    p.onGround = wp.onGround;
                    p.category = wp.category;
                    p.isEmergency = wp.isEmergency;
                    p.callsign = wp.callsign;
                    p.vRate = wp.vRate;
                    p.squawk = wp.squawk;
                    p.lastContact = wp.lastContact;
                    if (wp.typecode) p.typecode = wp.typecode;
                    // LSTM "Phase 2" smoothing target — see MapView.jsx animate().
                    p.predictedLat = wp.predictedLat ?? null;
                    p.predictedLng = wp.predictedLng ?? null;

                    // [Snapshot Interpolation v2.1 — WS path — Buffered + Jump Guard]
                    const wsRawDurMs = now - (p._dataArrivedAt ?? now);
                    const wsDurMs = Math.max(3000, Math.min(30000, wsRawDurMs));
                    // Long idle: always snap + discard stale trail. Same fix
                    // as the bbox-polling path's isStaleAfterIdle above — was
                    // `> 60000`, exactly trackIngest.js's own heartbeat
                    // guarantee with zero safety margin, on the PRIMARY (not
                    // fallback) update path. Raised to 90000 (PLANE_TTL_MS).
                    const wsIsStale = wsRawDurMs > 90000;

                    const wsRenderLat = p.renderLat ?? p._interpToLat ?? p._emaLat ?? wp.lat;
                    const wsRenderLng = p.renderLng ?? p._interpToLng ?? p._emaLng ?? wp.lng;

                    // Bearing check runs on the raw incoming position, before EMA —
                    // a rejected raw sample must not poison the EMA's running state,
                    // or the next (good) sample would be smoothed against corrupted
                    // history. On reject: skip the EMA update this cycle entirely.
                    const bearingRejected = !wsIsStale && !wp.onGround &&
                        _isBearingReversal(wsRenderLat, wsRenderLng, wp.lat, wp.lng, wp.heading);

                    // [EMA Position Smoothing — Aeris MLAT technique]
                    // α=0.72: 72% new + 28% prev — smooths MLAT noise (~100m)
                    // without significantly delaying ADS-B positions (~10m).
                    // First appearance: initialise EMA directly from raw position.
                    const EMA_ALPHA = 0.72;
                    let emaLat, emaLng;
                    if (bearingRejected) {
                        // Hold at the last trusted EMA position — do not fold the
                        // suspect sample in.
                        emaLat = p._emaLat ?? wsRenderLat;
                        emaLng = p._emaLng ?? wsRenderLng;
                    } else {
                        emaLat = (p._emaLat != null)
                            ? EMA_ALPHA * wp.lat + (1 - EMA_ALPHA) * p._emaLat
                            : wp.lat;
                        emaLng = (p._emaLng != null)
                            ? EMA_ALPHA * wp.lng + (1 - EMA_ALPHA) * p._emaLng
                            : wp.lng;
                        p._emaLat = emaLat;
                        p._emaLng = emaLng;
                    }

                    if (wsIsStale || (!bearingRejected && _isImpossibleJump(wsRenderLat, wsRenderLng, wp.lat, wp.lng, wsDurMs))) {
                        // Stale idle or impossible jump → snap directly, clear stale track
                        if (wsIsStale) trackStore.clearTrack(id);
                        p._interpFromLat = emaLat;
                        p._interpFromLng = emaLng;
                        p._interpToLat   = emaLat;
                        p._interpToLng   = emaLng;
                        p._interpStartMs = now;
                        p._interpDurMs   = wsDurMs;
                        p._pendingLat    = undefined;
                        p._pendingLng    = undefined;
                        p._pendingDurMs  = undefined;
                        p.renderLat      = emaLat;
                        p.renderLng      = emaLng;
                    } else {
                        // Lerp from wherever the plane is actually rendered right now
                        // (wsRenderLat/Lng), not from the previous segment's target —
                        // if this update arrives before the prior lerp finished, the
                        // old target isn't where the icon is, and using it as "from"
                        // causes a visible snap back to that stale point.
                        p._interpFromLat = wsRenderLat;
                        p._interpFromLng = wsRenderLng;
                        p._interpToLat   = emaLat;
                        p._interpToLng   = emaLng;
                        p._interpStartMs = now;
                        p._interpDurMs   = wsDurMs;
                        p._pendingLat    = undefined;
                        p._pendingLng    = undefined;
                        p._pendingDurMs  = undefined;
                    }

                    p._dataArrivedAt = now;
                    p.globalX = globalPt.x;
                    p.globalY = globalPt.y;

                    // Auto-Backfill trigger
                    if (wp._isNew && !backfilledIcaosRef.current.has(id) && !p.isBackfilling) {
                        p.isBackfilling = true;
                        backfillQueueRef.current.push(id);
                    }
                }

                for (let i = 0; i < removed.length; i++) {
                    delete planesDictRef.current[removed[i]];
                    trackStore.clearTrack(removed[i]);
                }

                setPlanesDict({ ...planesDictRef.current });
            } else if (type === 'TELEMETRY_UPDATED') {
                const { totalApiHits, nextFetchIn, accounts } = payload;
                setApiStats(prev => ({
                    ...prev,
                    totalCalls: totalApiHits,
                    accounts: accounts || []
                }));
                if (nextFetchIn !== undefined) {
                    setThrottleSeconds(nextFetchIn);
                }
            } else if (type === 'TRACK_POINT') {
                trackPointListenerRef.current?.(payload);
            }
        };

        const currentUrl = window.location.origin;
        worker.postMessage({ type: 'INIT', payload: { baseUrl: currentUrl } });

        // Page Visibility API — force reconnect when tab comes back into focus
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                logger.info('VIS', 'Page visible — forcing reconnect');
                worker.postMessage({ type: 'FORCE_RECONNECT' });
                setTimeout(() => fetchPlanes(false), 800);
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            worker.postMessage({ type: 'DISCONNECT' });
            worker.terminate();
        };
    }, [fetchPlanes]);

    return {
        planesDict,
        setPlanesDict,
        planeCount,
        airCount,
        groundCount,
        apiStatus,
        apiStatusClass,
        apiErrorDetail,
        throttleSeconds,
        latency,
        lastUpdateTime,
        apiStats,
        fetchPlanes,
        fetchTrack,
        syncViewport,
        deleteFromStore: (id) => trackStore.clearTrack(id), // Expose for manual cleaning
        flightHistoryRef,
        trackPointListenerRef,
        sendWorkerMessage: (msg) => { if (workerRef.current) workerRef.current.postMessage(msg); },
    };
}
