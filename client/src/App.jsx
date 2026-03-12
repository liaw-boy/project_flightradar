import React, { useState, useRef, useCallback, useEffect } from 'react';
import LoadingScreen from './components/LoadingScreen';
import Dashboard from './components/Dashboard';
import Sidebar from './components/Sidebar';
import SearchBar from './components/SearchBar';
import TopBar from './components/TopBar';
import MapView from './components/MapView';
import PlaneList from './components/PlaneList';
import TimePlayer from './components/TimePlayer';
import PerformanceMonitor from './components/PerformanceMonitor';
import { useFlightData } from './hooks/useFlightData';
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
        fleetFocus: '', // [v3.1] Airline ICAO filter (e.g. 'EVA', 'CAL')
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

    // [v2.9.0] Map tile layer
    const [mapLayer, setMapLayer] = useState(() =>
        localStorage.getItem('radar_map_layer') || 'dark'
    );
    const handleMapLayerChange = useCallback((layerId) => {
        setMapLayer(layerId);
        localStorage.setItem('radar_map_layer', layerId);
    }, []);

    // [v3.0] Anomaly alerts from server SSE
    const [anomalyAlerts, setAnomalyAlerts] = useState([]);

    // [v3.0] Track mode — map auto-pans to follow selected plane
    const [trackMode, setTrackMode] = useState(false);
    const handleToggleTrackMode = useCallback(() => setTrackMode(p => !p), []);

    // [v3.1] TimePlayer playback state — null means live, unix timestamp means historical
    const [playbackTime, setPlaybackTime] = useState(null);
    const handlePlaybackChange = useCallback((unixTime) => {
        setPlaybackTime(unixTime);
    }, []);

    const handleColorSchemeChange = useCallback((scheme) => {
        setColorScheme(scheme);
        localStorage.setItem('radar_color_scheme', scheme);
        logToServer(`Color scheme changed: ${scheme}`, 'info');
    }, []);

    const mapInstanceRef = useRef(null);

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
    } = useFlightData(mapInstanceRef);

    // [v2.9.0] SSE EventSource — real-time server push
    useEffect(() => {
        const es = new EventSource('/api/events');
        es.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.type === 'planes-updated') {
                    fetchPlanes(); // Immediate fetch on new data
                } else if (data.type === 'anomalies' && data.alerts?.length > 0) {
                    setAnomalyAlerts(prev => {
                        // Merge, deduplicate by icao24+type, keep latest 10
                        const merged = [...data.alerts, ...prev.filter(a =>
                            !data.alerts.some(b => b.icao24 === a.icao24 && b.type === a.type)
                        )].slice(0, 10);
                        return merged;
                    });
                }
            } catch (e) { /* ignore parse error */ }
        };
        es.onerror = () => { }; // Auto-reconnects natively
        return () => es.close();
    }, [fetchPlanes]);

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
            setPlaybackTime(null); // [v3.1] always start in LIVE mode when selecting a new plane
            setTrackMode(true); // 自動開啟追蹤模式

            // 取得軌跡
            const points = await fetchTrack(icao24, plane.lastContact);
            setTrackPoints(points);

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
        [fetchTrack]
    );

    // 取消選擇
    const handleDeselectPlane = useCallback(() => {
        setSelectedIcao24(null);
        setTrackPoints([]);
        setSelectedMetadata(null);
        setSelectedRoute(null);
        setTrackMode(false); // 取消追蹤模式
        setPlaybackTime(null); // [v3.1] clear playback on deselect

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
                mapLayer={mapLayer}
                trackMode={trackMode}
                playbackTime={playbackTime}
                t={t}
                translateMetar={translateMetar}
            />

            <TopBar
                planeCount={planeCount}
                airCount={airCount}
                groundCount={groundCount}
                apiStatus={apiStatus}
                apiStatusClass={apiStatusClass}
                planesDict={planesDict}
                onSearchSelect={handleSearchSelect}
                filters={filters}
                onFilterChange={handleFilterChange}
                colorScheme={colorScheme}
                onColorSchemeChange={handleColorSchemeChange}
                mapLayer={mapLayer}
                onMapLayerChange={handleMapLayerChange}
            />

            {/* Right Status Column */}
            <div className="right-hud">
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
                <PlaneList
                    planesDict={planesDict}
                    onSelectPlane={handleSelectPlane}
                    selectedIcao24={selectedIcao24}
                    filters={filters}
                />
            </div>

            {/* [v3.0] Anomaly Alert Panel */}
            {anomalyAlerts.length > 0 && (
                <div className="anomaly-panel">
                    <div className="anomaly-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                            </svg>
                            <span>ALERTS ({anomalyAlerts.length})</span>
                        </div>
                        <button onClick={() => setAnomalyAlerts([])} className="anomaly-close">✕</button>
                    </div>
                    {anomalyAlerts.map((alert, i) => (
                        <div
                            key={`${alert.icao24}-${alert.type}`}
                            className={`anomaly-item anomaly-${alert.severity}`}
                            onClick={() => handleSelectPlane(alert.icao24, planesDict[alert.icao24])}
                        >
                            <span className="anomaly-callsign">{alert.callsign || alert.icao24}</span>
                            <span className="anomaly-msg">{alert.message}</span>
                        </div>
                    ))}
                </div>
            )}

            {selectedPlane && (
                <Sidebar
                    plane={selectedPlane}
                    icao24={selectedIcao24}
                    metadata={selectedMetadata}
                    route={selectedRoute}
                    trackPoints={trackPoints}
                    playbackTime={playbackTime}
                    onPlaybackChange={handlePlaybackChange}
                    flightHistoryRef={flightHistoryRef}
                    onClose={handleDeselectPlane}
                    trackMode={trackMode}
                    onToggleTrack={handleToggleTrackMode}
                />
            )}

            <PerformanceMonitor usageStats={usageStats} />
        </div>
    );
}
