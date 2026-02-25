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
    const [latency, setLatency] = useState(null);
    const [lastUpdateTime, setLastUpdateTime] = useState(null);
    const [apiStats, setApiStats] = useState(null);

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
                if (response.status === 429) {
                    setApiStatus('RATE LIMITED');
                    setApiStatusClass('stat-warning');
                    throw new Error('API Rate Limited');
                }
                throw new Error(`API Error: ${response.status}`);
            }

            const data = await response.json();
            const parsedPlanes = parseOpenSkyData(data);

            if (parsedPlanes.length > 0) {
                processPlaneData(parsedPlanes);
                setApiStatus('OpenSky');
                setApiStatusClass('');
                setLastUpdateTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
            } else {
                setApiStatus('NO DATA');
                setApiStatusClass('stat-warning');
            }
        } catch (error) {
            const elapsed = Math.round(performance.now() - startTime);
            setLatency(elapsed);
            console.warn('❌ API Error:', error.message);

            if (error.name === 'AbortError') {
                setApiStatus('TIMEOUT');
            } else if (!apiStatusRef.current || apiStatusRef.current === 'INIT') {
                setApiStatus('ERROR');
            }
            setApiStatusClass('stat-error');

            // 失敗後 5 秒快速重試 (後端快取可能已有資料)
            setTimeout(() => {
                isFetchingRef.current = false;
                fetchPlanes();
            }, 5000);
            return; // 跳過下面的 isFetchingRef reset
        }

        isFetchingRef.current = false;
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
                history[icao24].push([pData.lat, pData.lng]);
                if (history[icao24].length > 50) history[icao24].shift();

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

    // 取得飛行軌跡
    const fetchTrack = useCallback(async (icao24) => {
        try {
            const res = await fetch(`/api/tracks?icao24=${icao24}`);
            if (!res.ok) throw new Error('API Error');
            const data = await res.json();

            if (data.path && data.path.length > 0) {
                const now = Math.floor(Date.now() / 1000);
                // path 格式: [time, lat, lng, altitude, heading, onGround]
                // 只保留時間戳 <= 當前時間的歷史點 (排除未來預測點)
                return data.path
                    .filter((p) => p[1] && p[2] && p[0] <= now)
                    .map((p) => [p[1], p[2]]);
            }
        } catch (e) {
            console.warn('無法獲取完整軌跡，使用本地歷史:', e.message);
        }

        // Fallback: 本地歷史
        const history = flightHistoryRef.current[icao24];
        return history && history.length > 1 ? history : [];
    }, []);

    // 拉取 API 統計
    const fetchApiStats = useCallback(async () => {
        try {
            const res = await fetch('/api/stats');
            if (res.ok) {
                const data = await res.json();
                setApiStats(data);
            }
        } catch (e) {
            // 靜默失敗
        }
    }, []);

    // 定時更新飛機 (測試階段 60秒，上線改回 11000)
    useEffect(() => {
        fetchPlanes();
        const interval = setInterval(fetchPlanes, 60000);
        return () => clearInterval(interval);
    }, [fetchPlanes]);

    // 定時拉取 API 統計 (每 30 秒)
    useEffect(() => {
        fetchApiStats();
        const interval = setInterval(fetchApiStats, 30000);
        return () => clearInterval(interval);
    }, [fetchApiStats]);

    return {
        planesDict,
        setPlanesDict,
        planeCount,
        airCount,
        groundCount,
        apiStatus,
        apiStatusClass,
        latency,
        lastUpdateTime,
        apiStats,
        fetchPlanes,
        fetchTrack,
        flightHistoryRef,
    };
}
