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
import { logToServer } from './utils/logger';
import './App.css';

// URL Parsing Utility
function parseUrlParams() {
    const params = new URLSearchParams(window.location.search);
    return {
        icao: params.get('icao'),
        lat: params.get('lat') ? parseFloat(params.get('lat')) : null,
        lng: params.get('lng') ? parseFloat(params.get('lng')) : null,
        zoom: params.get('zoom') ? parseInt(params.get('zoom'), 10) : null,
    };
}

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

    const [zoom, setZoom] = useState(10);
    const [usageStats, setUsageStats] = useState({
        visibleCount: 0,
        totalInView: 0,
        renderLimit: 0,
        throttleFactor: 1.0
    });

    const [colorScheme, setColorScheme] = useState(() => {
        return localStorage.getItem('radar_color_scheme') || 'TACTICAL';
    });

    const handleColorSchemeChange = useCallback((scheme) => {
        setColorScheme(scheme);
        localStorage.setItem('radar_color_scheme', scheme);
        logToServer(`Color scheme changed: ${scheme}`, 'info');
    }, []);

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
        flightHistoryRef,
    } = useFlightData(mapInstanceRef, showNotification);

    // Initial URL Params parsing
    const initializedUrlRef = useRef(false);

    // Global Keydown Listener
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                handleDeselectPlane();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

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
        const urlParams = parseUrlParams();
        if (urlParams.lat !== null && urlParams.lng !== null) {
            map.setView([urlParams.lat, urlParams.lng], urlParams.zoom || 10);
        }
        setZoom(map.getZoom());
    }, []);

    // 地圖移動 [v2.3.10] 新增防抖處理 (Debounce) 避免頻繁移動造成 API 負載
    const moveTimeoutRef = useRef(null);
    const handleMapMove = useCallback(() => {
        if (mapInstanceRef.current) {
            setZoom(mapInstanceRef.current.getZoom());
        }

        if (moveTimeoutRef.current) clearTimeout(moveTimeoutRef.current);
        moveTimeoutRef.current = setTimeout(() => {
            console.log('Map movement settled - pulling new BBox planes');
            fetchPlanes();
        }, 1500); // 1.5 秒內沒有新移動才抓取
    }, [fetchPlanes]);

    // 選中飛機
    const handleSelectPlane = useCallback(
        async (icao24, plane) => {
            logToServer(`Selected plane: ${plane.callsign || 'N/A'} (ICAO: ${icao24})`, 'info', { callsign: plane.callsign, icao24 });
            setSelectedIcao24(icao24);
            setTrackPoints([]); // Clear previous tracks immediately to prevent "ghost lines"
            setSelectedMetadata(null);
            setSelectedRoute(null);

            // 取得軌跡
            const points = await fetchTrack(icao24, plane.lastContact);
            setTrackPoints(points);

            // showNotification(`✈️ ${plane.callsign}`, 'info');

            // 背景取得 metadata + route (不阻塞 UI)
            fetch(`/api/metadata/${icao24}`)
                .then(r => r.json())
                .then(data => {
                    if (!data.noData) setSelectedMetadata(data);
                    else logToServer(`Metadata missing for ${icao24}`, 'warn');
                })
                .catch(e => { logToServer(`Metadata fetch error for ${icao24}: ${e.message}`, 'error'); });

            const callsignQuery = plane.callsign ? `?callsign=${plane.callsign.trim()}` : '';
            fetch(`/api/route/${icao24}${callsignQuery}`)
                .then(r => r.json())
                .then(data => {
                    if (data.noData) logToServer(`Route missing for ${plane.callsign || icao24}`, 'warn');
                    setSelectedRoute(data);
                })
                .catch(e => { logToServer(`Route fetch error for ${plane.callsign || icao24}: ${e.message}`, 'error'); });

            // Update URL
            const url = new URL(window.location);
            url.searchParams.set('icao', icao24);
            window.history.replaceState({}, '', url);
        },
        [fetchTrack, showNotification]
    );

    // 取消選擇
    const handleDeselectPlane = useCallback(() => {
        setSelectedIcao24(null);
        setTrackPoints([]);
        setSelectedMetadata(null);
        setSelectedRoute(null);

        // Remove ICAO from URL
        const url = new URL(window.location);
        url.searchParams.delete('icao');
        window.history.replaceState({}, '', url);
    }, []);

    // 過濾器變更
    const handleFilterChange = useCallback((key, value) => {
        logToServer(`Filter toggled: ${key} = ${value}`, 'info');
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

    // Check URL for ICAO auto-select once planesDict is populated
    useEffect(() => {
        if (!initializedUrlRef.current && Object.keys(planesDict).length > 0) {
            initializedUrlRef.current = true;
            const urlParams = parseUrlParams();
            if (urlParams.icao && planesDict[urlParams.icao]) {
                handleSelectPlane(urlParams.icao, planesDict[urlParams.icao]);
            }
        }
    }, [planesDict, handleSelectPlane]);

    return (
        <div className="app">
            <LoadingScreen visible={loading} />

            <MapView
                planesDict={planesDict}
                selectedIcao24={selectedIcao24}
                trackPoints={trackPoints}
                flightHistoryRef={flightHistoryRef}
                filters={filters}
                selectedRoute={selectedRoute}
                onSelectPlane={handleSelectPlane}
                onDeselectPlane={handleDeselectPlane}
                onMapReady={handleMapReady}
                onMapMove={handleMapMove}
                onUsageUpdate={setUsageStats}
                colorScheme={colorScheme}
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
                zoom={zoom}
                usageStats={usageStats}
            />

            <FilterPanel
                filters={filters}
                onFilterChange={handleFilterChange}
                colorScheme={colorScheme}
                onColorSchemeChange={handleColorSchemeChange}
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
