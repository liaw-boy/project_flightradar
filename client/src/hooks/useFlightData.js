import { useState, useRef, useCallback, useEffect } from 'react';
import { parseOpenSkyData, latLngToGlobalPixels } from '../utils/flightUtils';
import { trackStore } from '../store/FlightDataStore';
import { dataManager } from '../services/dataManager';

/**
 * 飛行資料管理 Hook
 * - 定時從後端 /api/states 拉取全球飛機資料
 * - 測量 API 延遲
 * - 從 /api/stats 拉取 API 使用統計
 * - 管理 planesDict、flightHistory
 */
export function useFlightData(mapRef) {
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
    const nextScheduledFetchRef = useRef(Date.now() + 60000);
    const workerRef = useRef(null);
    const usesWebSocketRef = useRef(false);
    
    // [v4.3.6] Auto-Backfill Queue for Cold Starts
    const backfillQueueRef = useRef([]);
    const backfilledIcaosRef = useRef(new Set());

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
                        callsign: p.callsign || 'UNKNOWN',
                        registration: p.callsign || 'N/A', // fallback
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
            } else {
                setApiStatus('NO DATA');
                setApiStatusClass('stat-warning');
                setApiErrorDetail('API reached successfully but returned 0 planes.');
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
            const elapsed = Math.round(performance.now() - startTime);
            setLatency(elapsed);
            console.warn('❌ API Error:', error.message);

            if (error.name === 'AbortError') {
                setApiStatus('TIMEOUT');
                setApiErrorDetail('Request took longer than 20s to resolve.');
            } else if (!apiStatusRef.current || apiStatusRef.current === 'INIT') {
                setApiStatus('ERROR');
                setApiErrorDetail(error.message);
            } else {
                setApiErrorDetail(error.message);
            }
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

                    next[icao24] = {
                        ...pData,
                        isDirty: true,
                        lastCallsign: '',
                        renderLat: pData.lat,
                        renderLng: pData.lng,
                        targetLat: pData.lat,
                        targetLng: pData.lng,
                        targetUpdatedAt: Date.now(),
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

                    next[icao24] = {
                        ...existing,
                        ...pData,
                        isDirty,
                        targetLat: pData.lat,
                        targetLng: pData.lng,
                        targetUpdatedAt: Date.now(),
                        globalX: globalPt.x, // [v3.0] Space Decoupling
                        globalY: globalPt.y
                    };
                }
            });

            // 清理機制：不再根據這次 BBox 結果刪除，而是根據「過期時間」
            // 只有當飛機最後一次在後端全球快取出現的時間比當前最新的全球刷新時間早 60 秒以上，才視為消失
            const globalSnapshotTime = globalLastUpdateRef.current || Math.floor(Date.now() / 1000);
            Object.keys(next).forEach((id) => {
                const p = next[id];
                // 如果這架飛機太久沒出現在全球快取中，則清理
                if (p.lastSeenTime && globalSnapshotTime - p.lastSeenTime > 60) {
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
        return R * c;
    };

    const fetchTrack = useCallback(async (icao24, lastContact) => {
        try {
            const data = await dataManager.getTrack(icao24, lastContact);

            if (data.path && data.path.length > 0) {
                // 如果沒有傳入 lastContact，才 fallback 到當前時間
                const limitTime = lastContact || Math.floor(Date.now() / 1000);

                // path 格式: [time, lat, lng, altitude, heading, onGround]
                // 只保留時間戳 <= 飛機目前最後更新時間 的歷史點 (排除未來預測點)
                // [BUGFIX] Sort FIRST by time ascending so all index calculations are correct
                const validPoints = data.path
                    .filter((p) => p[1] && p[2] && p[0] <= limitTime)
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
            console.warn('無法獲取完整軌跡，使用本地歷史:', e.message);
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

        // [v3.1] Return full tuple for TimePlayer from local history
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
            const selectedIcao = urlParams.get('selected');
            
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
                    // [v4.5.1] Seamless Merge & Deduplication
                    // 1. Get current points from store (Live Points)
                    const livePoints = [];
                    trackStore.getTrackPoints(icao24, (time, lat, lng, x, y) => {
                        livePoints.push([time, lat, lng, x, y]);
                    });

                    // 2. Combine with Historical Path and Deduplicate by Time
                    // Convert historical path [time, lat, lng, alt, head, vel] to [time, lat, lng]
                    const historicalPoints = path.map(p => [p[0], p[1], p[2]]);
                    
                    // Full Blend: Set used to track unique timestamps
                    const seenTimes = new Set();
                    const merged = [];
                    
                    // Process: Historical first, then Live
                    [...historicalPoints, ...livePoints].forEach(pt => {
                        const time = pt[0];
                        if (!seenTimes.has(time)) {
                            seenTimes.add(time);
                            merged.push(pt);
                        }
                    });

                    // Sort strict by time (old to new)
                    merged.sort((a, b) => a[0] - b[0]);

                    // 3. Re-inject fully merged track into store
                    trackStore.clearTrack(icao24);
                    const zoom = mapRef.current ? mapRef.current.getZoom() : 5;
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
                                    isDirty: true,
                                    forceUpdate: Date.now(),
                                    _renderTrigger: Math.random() // Extra safety for shallow comparison
                                } 
                            };
                        }
                        return prev;
                    });
                }
            } catch (e) {
                console.error('Backfill Merge Error:', e);
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
    }, []);

    // [Project AERO-SYNC] Initialize WebWorker for WebSocket Binary Stream
    useEffect(() => {
        const worker = new Worker(new URL('../workers/FlightDataWorker.js', import.meta.url), { type: 'module' });
        workerRef.current = worker;

        worker.onmessage = (event) => {
            const { type, payload } = event.data;
            if (type === 'WS_CONNECTED') {
                setApiStatus('AERO-SYNC (WS)');
                setApiStatusClass('stat-success');
                usesWebSocketRef.current = true;
                setApiErrorDetail('');
            } else if (type === 'WS_DISCONNECTED' || type === 'WS_ERROR') {
                usesWebSocketRef.current = false;
                setApiStatus('FALLBACK (Polling)');
                setApiStatusClass('stat-warning');
                fetchPlanes(false); // Trigger immediate fallback fetch
            } else if (type === 'PLANES_UPDATED') {
                const { updates = [], removed = [], globalTime } = payload;
                globalLastUpdateRef.current = globalTime;
                setLastUpdateTime(new Date().toLocaleTimeString('en-US', { hour12: false }));

                const map = mapRef.current;
                const zoom = map ? map.getZoom() : 5;
                const now = Date.now();

                // 1. [AERO-SYNC] 更新可變的即時參照 (Mutable Reference)
                // 這是渲染循環的資料源，完全繞過 React State Diffing
                updates.forEach(u => {
                    const id = u[0];
                    // Format: [icao24, lat, lng, heading, altitude, velocity, onGround, category, isEmergency, callsign, vRate, squawk, lastContact]
                    const lat = u[1];
                    const lng = u[2];

                    // 投影校正並存入 Zero-GC Store
                    const globalPt = latLngToGlobalPixels(lat, lng, zoom, sharedPointRef.current);
                    trackStore.addTrackPoint(id, lat, lng, globalPt.x, globalPt.y);

                    // 更新即時狀態 (Mutable Ref)
                    let p = planesDictRef.current[id];
                    if (!p) {
                        p = { icao24: id };
                        planesDictRef.current[id] = p; // 動態加入新飛機
                    }

                    p.lat = lat;
                    p.lng = lng;
                    p.heading = u[3];
                    p.altitude = u[4];
                    p.velocity = u[5];
                    p.onGround = u[6];
                    p.category = u[7];
                    p.isEmergency = u[8];
                    p.callsign = u[9];
                    p.vRate = u[10];
                    p.squawk = u[11];
                    p.lastContact = u[12];

                    // 渲染座標初始化/更新
                    p.renderLat = lat;
                    p.renderLng = lng;
                    p.targetLat = lat;
                    p.targetLng = lng;
                    p.targetUpdatedAt = now;
                    p.globalX = globalPt.x;
                    p.globalY = globalPt.y;

                    // [v4.4.0] Trigger Enhanced Auto-Backfill (WS stream)
                    if (!backfilledIcaosRef.current.has(id) && !p.isBackfilling) {
                        p.isBackfilling = true;
                        backfillQueueRef.current.push(id);
                    }
                });

                removed.forEach(id => {
                    delete planesDictRef.current[id];
                    trackStore.clearTrack(id); // [v4.1.2] Synchronous GC: Kill the ghost track immediately
                });

                // 2. [AERO-SYNC] 智能節流 React State 更新
                // 必須穩定觸發 setPlanesDict，確保 MapView 拿到最新的字典參照
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
            }
        };

        const currentUrl = window.location.origin;
        worker.postMessage({ type: 'INIT', payload: { baseUrl: currentUrl } });

        return () => {
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
    };
}
