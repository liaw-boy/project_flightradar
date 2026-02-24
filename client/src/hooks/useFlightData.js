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
        const map = mapRef.current;
        if (!map || isFetchingRef.current || map.getZoom() < 6) return;

        isFetchingRef.current = true;

        const bounds = map.getBounds();
        const zoom = map.getZoom();
        const cacheKey = `${bounds.getCenter().lat.toFixed(1)}_${bounds.getCenter().lng.toFixed(1)}_${zoom}`;

        // 檢查快取（5 分鐘）
        if (cacheRef.current.has(cacheKey)) {
            const cached = cacheRef.current.get(cacheKey);
            if (Date.now() - cached.timestamp < 300000) {
                processPlaneData(cached.data);
                isFetchingRef.current = false;
                return;
            }
        }

        try {
            const url = `/api/states?lamin=${bounds.getSouth()}&lomin=${bounds.getWest()}&lamax=${bounds.getNorth()}&lomax=${bounds.getEast()}`;
            const response = await fetch(url);
            const textData = await response.text();

            if (textData.includes('Too many requests') || textData.includes('<html') || !response.ok) {
                throw new Error('API Blocked or Rate Limited');
            }

            const data = JSON.parse(textData);
            const parsedPlanes = parseOpenSkyData(data);

            cacheRef.current.set(cacheKey, { data: parsedPlanes, timestamp: Date.now() });
            if (cacheRef.current.size > 10) {
                const firstKey = cacheRef.current.keys().next().value;
                cacheRef.current.delete(firstKey);
            }

            processPlaneData(parsedPlanes);
            setApiStatus('OpenSky');
            setApiStatusClass('');
        } catch (error) {
            console.warn('❌ API Error:', error.message);
            setApiStatus('ERROR');
            setApiStatusClass('stat-error');
            showNotification?.('⚠️ API 失敗，請稍後重試', 'error');
        }

        isFetchingRef.current = false;
    }, [mapRef, showNotification]);

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

    // 定時更新
    useEffect(() => {
        fetchPlanes();
        const interval = setInterval(fetchPlanes, 30000);
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
