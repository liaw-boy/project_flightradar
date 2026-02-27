import { useState, useRef, useCallback, useEffect } from 'react';
import { parseOpenSkyData } from '../utils/flightUtils';

/**
 * 飛行資料管理 Hook
 * - 定時從後端 /api/states 拉取全球飛機資料
 * - 測量 API 延遲
 * - 從 /api/stats 拉取 API 使用統計
 * - 管理 planesDict、flightHistory
 */
export function useFlightData(mapRef, showNotification) {
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
    const [throttleSeconds, setThrottleSeconds] = useState(30);

    const flightHistoryRef = useRef({});
    const isFetchingRef = useRef(false);
    const planesDictRef = useRef({});
    const apiStatusRef = useRef('INIT');

    // 保持 ref 和 state 同步
    useEffect(() => {
        planesDictRef.current = planesDict;
    }, [planesDict]);

    useEffect(() => {
        apiStatusRef.current = apiStatus;
    }, [apiStatus]);

    const fetchPlanes = useCallback(async () => {
        if (isFetchingRef.current) return;
        isFetchingRef.current = true;

        const startTime = performance.now();

        try {
            // [Global Fetch] 抓取全球資料 (20秒超時)
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);

            const response = await fetch('/api/states', { signal: controller.signal });
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

            const intervalDelay = data.recommendedInterval || 30;
            setThrottleSeconds(intervalDelay);

            const parsedPlanes = parseOpenSkyData(data, data.stale === true);

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

            // 排定下一次抓取 (依照後端要求的安全時間延展)
            setTimeout(() => {
                isFetchingRef.current = false;
                fetchPlanes();
            }, intervalDelay * 1000);

            return; // 成功結束，不需要走 default finally
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

            // 失敗後 5 秒快速重試 (不要太快，給後端一點喘息空間)
            setTimeout(() => {
                isFetchingRef.current = false;
                fetchPlanes();
            }, 5000);
            return;
        }
    }, []);

    // 處理飛機資料
    const processPlaneData = useCallback((planes) => {
        const currentIcaos = new Set();
        const history = flightHistoryRef.current;
        let air = 0;
        let gnd = 0;

        setPlanesDict((prev) => {
            const next = { ...prev };

            planes.forEach(({ icao24, data: pData }) => {
                currentIcaos.add(icao24);

                // 計算 AIR / GND
                if (pData.onGround) gnd++;
                else air++;

                if (!history[icao24]) history[icao24] = [];
                // 儲存 [時間戳, 緯度, 經度, 是否在地面]
                const nowUnix = Math.floor(Date.now() / 1000);
                history[icao24].push([nowUnix, pData.lat, pData.lng, pData.onGround]);
                if (history[icao24].length > 500) history[icao24].shift(); // 保留 500 個點 (~83分鐘追蹤)

                if (!next[icao24]) {
                    next[icao24] = { ...pData, isDirty: true, lastCallsign: '' };
                } else {
                    const existing = next[icao24];
                    const isDirty =
                        existing.heading !== pData.heading ||
                        existing.altitude !== pData.altitude ||
                        existing.callsign !== pData.callsign ||
                        existing.onGround !== pData.onGround ||
                        existing.isEmergency !== pData.isEmergency;

                    next[icao24] = {
                        ...existing,
                        ...pData,
                        isDirty,
                        targetLat: pData.lat,
                        targetLng: pData.lng,
                    };
                }
            });

            // 清理消失的飛機
            Object.keys(next).forEach((id) => {
                if (!currentIcaos.has(id)) {
                    delete next[id];
                    delete history[id];
                }
            });

            setPlaneCount(currentIcaos.size);
            setAirCount(air);
            setGroundCount(gnd);
            return next;
        });
    }, []);

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

    const fetchTrack = useCallback(async (icao24, lastContact) => {
        try {
            const timeParam = lastContact ? `&time=${lastContact}` : '';
            const res = await fetch(`/api/tracks?icao24=${icao24}${timeParam}`);
            if (!res.ok) throw new Error('API Error');
            const data = await res.json();

            if (data.path && data.path.length > 0) {
                // 如果沒有傳入 lastContact，才 fallback 到當前時間
                const limitTime = lastContact || Math.floor(Date.now() / 1000);

                // path 格式: [time, lat, lng, altitude, heading, onGround]
                // 只保留時間戳 <= 飛機目前最後更新時間 的歷史點 (排除未來預測點)
                const validPoints = data.path.filter((p) => p[1] && p[2] && p[0] <= limitTime);

                // 找出最新的飛行航段：
                // 1. 絕對切斷：時間間隔大於 15 分鐘 (900 秒)，代表上一趟飛完停著沒關機
                // 2. 條件切斷：如果現在飛機「正在地面 (目前點)」，我們把每一秒在地上滑行的都當作新的起點，不畫出長長的地面滑行線
                let latestSegmentStartIdx = 0;
                const isCurrentlyOnGround = validPoints[validPoints.length - 1][5] === true;

                for (let i = 1; i < validPoints.length; i++) {
                    const timeDiff = validPoints[i][0] - validPoints[i - 1][0];
                    const isOnGround = validPoints[i][5] === true; // path[5] 是 onGround

                    if (timeDiff > 1800 && (validPoints[i - 1][5] === true || isOnGround)) {
                        // 飛機在地面上且超過 30 分鐘沒更新，代表前一次是舊的航班
                        latestSegmentStartIdx = i;
                    } else if (isOnGround && isCurrentlyOnGround) {
                        // 如果飛機最終狀態停在地上，那我們遇到地面的點就切斷，避免畫出機場亂轉的線
                        latestSegmentStartIdx = i;
                    } else if (timeDiff > 0) {
                        // 檢查是否為不合理的神仙跳躍 (超過音速 400m/s，且時間間隔 > 30秒)
                        // 有時候 OpenSky 會把昨日的軌跡跟今日的接在一起，導致超大直線
                        const dist = getDistance(validPoints[i - 1][1], validPoints[i - 1][2], validPoints[i][1], validPoints[i][2]);
                        if (timeDiff > 30 && (dist / timeDiff) > 400) {
                            latestSegmentStartIdx = i; // Impossible speed, sever the track
                        }
                    }
                }

                return validPoints.slice(latestSegmentStartIdx).map((p) => [p[1], p[2]]);
            }
        } catch (e) {
            console.warn('無法獲取完整軌跡，使用本地歷史:', e.message);
        }

        // Fallback: 本地歷史
        const history = flightHistoryRef.current[icao24];
        if (!history || history.length < 2) return [];

        let latestSegmentStartIdx = 0;
        for (let i = 1; i < history.length; i++) {
            const timeDiff = history[i][0] - history[i - 1][0];
            const wasOnGround = history[i - 1][3] === true;
            const dist = getDistance(history[i - 1][1], history[i - 1][2], history[i][1], history[i][2]);

            if ((isOnGround && history[history.length - 1][3] === true) ||
                (timeDiff > 1800 && (wasOnGround || isOnGround)) ||
                (timeDiff > 30 && (dist / timeDiff) > 400)) {
                latestSegmentStartIdx = i;
            }
        }
        return history.slice(latestSegmentStartIdx).map((p) => [p[1], p[2]]);
    }, []);

    // 定時更新飛機    // 初次載入驅動迴圈
    useEffect(() => {
        if (!isFetchingRef.current) {
            fetchPlanes();
        }

        // Timer countdown sync for UI (不負責 fetch，只負責倒數顯示)
        const uiTimer = setInterval(() => {
            setThrottleSeconds((prev) => Math.max(0, prev - 1));
        }, 1000);

        return () => clearInterval(uiTimer);
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
        flightHistoryRef,
    };
}
