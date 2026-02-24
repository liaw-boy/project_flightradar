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
import './App.css';

export default function App() {
    const [loading, setLoading] = useState(true);
    const [selectedIcao24, setSelectedIcao24] = useState(null);
    const [trackPoints, setTrackPoints] = useState([]);
    const [filters, setFilters] = useState({
        showGround: true,
        showEmergency: true,
        showLow: true,
    });

    const mapInstanceRef = useRef(null);
    const { notifications, showNotification } = useNotification();
    const {
        planesDict,
        planeCount,
        apiStatus,
        apiStatusClass,
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
        fetchPlanes();
    }, [fetchPlanes]);

    // 選中飛機
    const handleSelectPlane = useCallback(
        async (icao24, plane) => {
            setSelectedIcao24(icao24);

            // 取得軌跡
            const points = await fetchTrack(icao24);
            setTrackPoints(points);

            showNotification(`✈️ ${plane.callsign}`, 'info');
        },
        [fetchTrack, showNotification]
    );

    // 取消選擇
    const handleDeselectPlane = useCallback(() => {
        setSelectedIcao24(null);
        setTrackPoints([]);
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
                onSelectPlane={handleSelectPlane}
                onDeselectPlane={handleDeselectPlane}
                onMapReady={handleMapReady}
                onMapMove={handleMapMove}
            />

            <SearchBar
                planesDict={planesDict}
                onSelectPlane={handleSearchSelect}
            />

            <Dashboard
                planeCount={planeCount}
                apiStatus={apiStatus}
                apiStatusClass={apiStatusClass}
            />

            <FilterPanel
                filters={filters}
                onFilterChange={handleFilterChange}
            />

            {selectedPlane && (
                <Sidebar
                    plane={selectedPlane}
                    icao24={selectedIcao24}
                    onClose={handleDeselectPlane}
                />
            )}

            <NotificationContainer notifications={notifications} />
        </div>
    );
}
