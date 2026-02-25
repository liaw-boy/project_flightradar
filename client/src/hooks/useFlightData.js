import { useState, useRef, useCallback, useEffect } from 'react';
import { parseOpenSkyData } from '../utils/flightUtils';

/**
 * 飛行資料管理 Hook
 * - 定時從後端 /api/states 拉取飛機資料
 * - 管理 planesDict、flightHistory
 * - 地圖移動時觸發更新
 */
export function useFlightData(mapRef, showNotification) {
    const [planesDict, setPlanesDict] = useState({});
    const [planeCount, setPlaneCount] = useState(0);
    const [apiStatus, setApiStatus] = useState('INIT');
    const [apiStatusClass, setApiStatusClass] = useState('');

    const flightHistoryRef = useRef({});
    const isFetchingRef = useRef(false);
    const cacheRef = useRef(new Map());
    const planesDictRef = useRef({});

    // 保持 ref 和 state 同步
    useEffect(() => {
        planesDictRef.current = planesDict;
    }, [planesDict]);

    const fetchPlanes = useCallback(async () => {
        if (isFetchingRef.current) return;
        isFetchingRef.current = true;

        try {
            // [Global Fetch] 抓取全球資料，不帶座標參數
            const response = await fetch('/api/states');

            if (!response.ok) {
                const textData = await response.text();
                if (response.status === 429 || textData.includes('Too many requests')) {
                    throw new Error('API Rate Limited');
                }
                throw new Error('API Error');
            }

            const data = await response.json();
            const parsedPlanes = parseOpenSkyData(data); // 假設 utils 有這個通用解析函數

            processPlaneData(parsedPlanes);
            setApiStatus('OpenSky');
            setApiStatusClass('');
        } catch (error) {
            console.warn('❌ API Error:', error.message);
            setApiStatus('ERROR');
            setApiStatusClass('stat-error');
            // showNotification?.('⚠️ API 連線異常', 'error'); // 降噪，不一直彈跳
        }

        isFetchingRef.current = false;
    }, []);

    // 處理飛機資料
    const processPlaneData = useCallback((planes) => {
        const currentIcaos = new Set();
        const history = flightHistoryRef.current;

        setPlanesDict((prev) => {
            const next = { ...prev };

            planes.forEach(({ icao24, data: pData }) => {
                currentIcaos.add(icao24);

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
                return data.path.filter((p) => p[1] && p[2]).map((p) => [p[1], p[2]]);
            }
        } catch (e) {
            console.warn('無法獲取完整軌跡，使用本地歷史:', e.message);
        }

        // Fallback: 本地歷史
        const history = flightHistoryRef.current[icao24];
        return history && history.length > 1 ? history : [];
    }, []);

    // 定時更新 (測試階段 60秒，上線改回 11000)
    useEffect(() => {
        fetchPlanes();
        const interval = setInterval(fetchPlanes, 60000);
        return () => clearInterval(interval);
    }, [fetchPlanes]);

    return {
        planesDict,
        setPlanesDict,
        planeCount,
        apiStatus,
        apiStatusClass,
        fetchPlanes,
        fetchTrack,
        flightHistoryRef,
    };
}
