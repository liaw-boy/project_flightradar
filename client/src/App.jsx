import React, { useState, useRef, useCallback, useEffect } from 'react';
import LoadingScreen from './components/LoadingScreen';
import Dashboard from './components/Dashboard';
import Sidebar from './components/Sidebar';
import SearchBar from './components/SearchBar';
import FilterPanel from './components/FilterPanel';
import NotificationContainer from './components/NotificationContainer';
import MapView from './components/MapView';
import { useFlightData } from './hooks/useFlightData';
import { useNotification } from './hooks/useNotification';
import { useI18n } from './hooks/useI18n';
import './App.css';

export default function App() {
    const { t, translateMetar } = useI18n();
    const [loading, setLoading] = useState(true);
    const [selectedIcao24, setSelectedIcao24] = useState(null);
    const [trackPoints, setTrackPoints] = useState([]);
    const [selectedMetadata, setSelectedMetadata] = useState(null);
    const [selectedRoute, setSelectedRoute] = useState(null);
    const [filters, setFilters] = useState({
        showGround: true,
        showEmergency: true,
        showLow: true,
        showAirports: true,
    });

    const mapInstanceRef = useRef(null);
    const { notifications, showNotification } = useNotification();
    const {
        planesDict,
        planeCount,
        airCount,
        groundCount,
        apiStatus,
        apiStatusClass,
        apiErrorDetail,
        latency,
        lastUpdateTime,
        apiStats,
        throttleSeconds,
        fetchPlanes,
        fetchTrack,
    } = useFlightData(mapInstanceRef, showNotification);

    // 載入動畫
    useEffect(() => {
        const timer = setTimeout(() => {
            setLoading(false);
            showNotification('🚀 雷達系統已啟動', 'info');
        }, 1500);
        return () => clearTimeout(timer);
    }, []);

    // 地圖就緒
    const handleMapReady = useCallback((map) => {
        mapInstanceRef.current = map;
    }, []);

    // 地圖移動
    const handleMapMove = useCallback(() => {
        // [Zero-Latency Panning] 
        // 地圖移動不再觸發 API 請求，僅由 MapView 負責本地過濾渲染
        // fetchPlanes(); 
        console.log('Map moved - re-filtering local planes');
    }, []);

    // 選中飛機
    const handleSelectPlane = useCallback(
        async (icao24, plane) => {
            setSelectedIcao24(icao24);
            setSelectedMetadata(null);
            setSelectedRoute(null);

            // 取得軌跡
            const points = await fetchTrack(icao24, plane.lastContact);
            setTrackPoints(points);

            showNotification(`✈️ ${plane.callsign}`, 'info');

            // 背景取得 metadata + route (不阻塞 UI)
            fetch(`/api/metadata/${icao24}`)
                .then(r => r.json())
                .then(data => { if (!data.noData) setSelectedMetadata(data); })
                .catch(() => { });

            const callsignQuery = plane.callsign ? `?callsign=${plane.callsign.trim()}` : '';
            fetch(`/api/route/${icao24}${callsignQuery}`)
                .then(r => r.json())
                .then(data => { setSelectedRoute(data); })
                .catch(() => { });
        },
        [fetchTrack, showNotification]
    );

    // 取消選擇
    const handleDeselectPlane = useCallback(() => {
        setSelectedIcao24(null);
        setTrackPoints([]);
        setSelectedMetadata(null);
        setSelectedRoute(null);
    }, []);

    // 過濾器變更
    const handleFilterChange = useCallback((key, value) => {
        setFilters((prev) => ({ ...prev, [key]: value }));
    }, []);

    // 搜尋選中飛機
    const handleSearchSelect = useCallback(
        (icao24, plane) => {
            handleSelectPlane(icao24, plane);
        },
        [handleSelectPlane]
    );

    // 當前選中的飛機資料
    const selectedPlane = selectedIcao24 ? planesDict[selectedIcao24] : null;

    return (
        <div className="app">
            <LoadingScreen visible={loading} />

            <MapView
                planesDict={planesDict}
                selectedIcao24={selectedIcao24}
                trackPoints={trackPoints}
                filters={filters}
                selectedRoute={selectedRoute}
                onSelectPlane={handleSelectPlane}
                onDeselectPlane={handleDeselectPlane}
                onMapReady={handleMapReady}
                onMapMove={handleMapMove}
                t={t}
                translateMetar={translateMetar}
            />

            <SearchBar
                planesDict={planesDict}
                onSelectPlane={handleSearchSelect}
            />

            <Dashboard
                planeCount={planeCount}
                airCount={airCount}
                groundCount={groundCount}
                apiStatus={apiStatus}
                apiStatusClass={apiStatusClass}
                apiErrorDetail={apiErrorDetail}
                latency={latency}
                lastUpdateTime={lastUpdateTime}
                nextRefresh={throttleSeconds}
                apiStats={apiStats}
            />

            <FilterPanel
                filters={filters}
                onFilterChange={handleFilterChange}
            />

            {selectedPlane && (
                <Sidebar
                    plane={selectedPlane}
                    icao24={selectedIcao24}
                    metadata={selectedMetadata}
                    route={selectedRoute}
                    onClose={handleDeselectPlane}
                />
            )}

            <NotificationContainer notifications={notifications} />
        </div>
    );
}
