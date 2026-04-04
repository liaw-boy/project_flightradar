import React, { useState, useRef, useCallback, useEffect } from 'react';
import LoadingScreen from './components/LoadingScreen';
import Dashboard from './components/Dashboard';
import DevPanel from './components/DevPanel';
import Sidebar from './components/Sidebar';
import SearchBar from './components/SearchBar';
import TopBar from './components/TopBar';
import MapView from './components/MapView';
import PlaneList from './components/PlaneList';
import TimePlayer from './components/TimePlayer';
import PerformanceMonitor from './components/PerformanceMonitor';
import { useFlightData } from './hooks/useFlightData';
import { useI18n } from './hooks/useI18n';
import { logToServer, logger } from './utils/logger';
import { dataManager } from './services/dataManager';
import { initAircraftShapes } from './utils/aircraftIcons';
import { trackStore } from './store/FlightDataStore';
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

    const colorScheme = 'TACTICAL';

    // [v2.9.0] Map tile layer
    const [mapLayer, setMapLayer] = useState(() =>
        localStorage.getItem('radar_map_layer') || 'dark'
    );
    const handleMapLayerChange = useCallback((layerId) => {
        setMapLayer(layerId);
        localStorage.setItem('radar_map_layer', layerId);
    }, []);

    // [v4.2.0] Anomaly alerts from server SSE
    const [anomalyAlerts, setAnomalyAlerts] = useState([]);

    // [v4.2.0] Track mode — map auto-pans to follow selected plane
    const [trackMode, setTrackMode] = useState(false);
    const handleToggleTrackMode = useCallback(() => setTrackMode(p => !p), []);

    // [v4.2.0] TimePlayer playback state — null means live, unix timestamp means historical
    const [playbackTime, setPlaybackTime] = useState(null);
    const handlePlaybackChange = useCallback((unixTime) => {
        setPlaybackTime(unixTime);
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
        syncViewport,
        flightHistoryRef,
    } = useFlightData(mapInstanceRef);

    // [v2.9.0] SSE EventSource — real-time server push
    // fetchPlanesRef keeps the latest fetchPlanes without causing SSE reconnects
    const fetchPlanesRef = useRef(fetchPlanes);
    useEffect(() => { fetchPlanesRef.current = fetchPlanes; }, [fetchPlanes]);

    useEffect(() => {
        const es = new EventSource('/api/events');
        es.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.type === 'planes-updated') {
                    fetchPlanesRef.current(); // Immediate fetch on new data
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
    }, []); // SSE connection runs once for the lifetime of the app

    // Initial URL Params parsing
    const initializedUrlRef = useRef(false);

    // Dev Panel visibility (Ctrl+D toggle, persisted)
    const [showDevPanel, setShowDevPanel] = useState(
        () => localStorage.getItem('devpanel_visible') === '1'
    );

    // Global Keydown Listener
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                handleDeselectPlane();
            }
            // Ctrl+D — toggle developer monitor panel
            if (e.ctrlKey && e.key === 'd') {
                e.preventDefault();
                setShowDevPanel(v => {
                    const next = !v;
                    localStorage.setItem('devpanel_visible', next ? '1' : '0');
                    return next;
                });
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // 初始化飛機形狀 (從 MongoDB 載入 SVG 輪廓)
    useEffect(() => {
        dataManager.getAircraftShapes().then(shapes => {
            if (shapes.length > 0) initAircraftShapes(shapes);
        });
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
            logger.debug('UI', 'Map movement settled — pulling new BBox planes');
            fetchPlanes();
        }, 1500); // 1.5 秒內沒有新移動才抓取
    }, [fetchPlanes]);

    // 選中飛機
    const handleSelectPlane = useCallback(
        async (icao24, plane) => {
            logToServer(`Selected plane: ${plane.callsign || 'N/A'} (ICAO: ${icao24})`, 'info', { callsign: plane.callsign, icao24 });
            if (selectedIcao24 !== icao24) {
                setTrackPoints([]); 
                setSelectedMetadata(null);
                setSelectedRoute(null);
                setPlaybackTime(null);
            }
            setSelectedIcao24(icao24);
            setTrackMode(true);
            
            // [v11.0] Activate High-Res Zero-Truncation Buffer
            trackStore.setSelected(icao24);

            // Fetch track immediately (blocks slightly but necessary for visual sync)
            try {
                const points = await fetchTrack(icao24, plane.lastContact);
                setTrackPoints(points || []);
            } catch (e) {
                setTrackPoints([]);
            }

            // [AERO-SYNC] Helper for Fetch with Timeout
            const fetchWithTimeout = (promise, ms = 5000) => {
                const timeout = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('TIMEOUT')), ms);
                });
                return Promise.race([promise, timeout]);
            };

            // Background Metadata + Route (Non-blocking with 5s Timeout)
            fetchWithTimeout(dataManager.getMetadata(icao24))
                .then(data => {
                    if (data && !data.noData) setSelectedMetadata(data);
                    else setSelectedMetadata({ noData: true });
                })
                .catch(e => {
                    logger.warn('UI', `Metadata fetch failed for ${icao24}: ${e.message}`);
                    setSelectedMetadata({ noData: true });
                });

            fetchWithTimeout(dataManager.getRoute(icao24, plane.callsign))
                .then(data => {
                    if (data && !data.noData) setSelectedRoute(data);
                    else setSelectedRoute({ noData: true });
                })
                .catch(e => {
                    logger.warn('UI', `Route fetch failed for ${plane.callsign}: ${e.message}`);
                    setSelectedRoute({ noData: true });
                });

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
        
        // [v11.0] Deactivate High-Res Buffer
        trackStore.setSelected(null);

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

    // [Fix] Periodic track refresh — keeps the historical trail growing as the plane flies.
    // Uses a ref for planesDict to avoid stale closures inside the interval callback.
    const planesDictRef = useRef(planesDict);
    useEffect(() => { planesDictRef.current = planesDict; }, [planesDict]);

    useEffect(() => {
        if (!selectedIcao24) return;
        const timer = setInterval(async () => {
            const plane = planesDictRef.current[selectedIcao24];
            if (!plane) return;
            try {
                const newPoints = await fetchTrack(selectedIcao24, plane.lastContact, true); // bypass LRU
                if (!newPoints || newPoints.length === 0) return;
                setTrackPoints(prev => {
                    if (!prev || prev.length === 0) return newPoints;
                    // Immutable merge: keep all existing points, append only truly new ones
                    const latestTime = prev[prev.length - 1][0];
                    const fresh = newPoints.filter(p => p[0] > latestTime);
                    return fresh.length > 0 ? [...prev, ...fresh] : prev;
                });
            } catch (_) {}
        }, 30000); // every 30 s — matches backend TrackPoint ingest cycle
        return () => clearInterval(timer);
    }, [selectedIcao24, fetchTrack]);

    // [v4.1.0] Auto-Deselection Guard: 如果選中的飛機消失在數據流中，自動取消選取
    // [Fix] When trackMode is active the selected plane may legitimately move outside
    // the current BBox (e.g., mid-pan) — do NOT clear the track in that case.
    // We only auto-deselect when the user has NOT pinned the plane (trackMode=false).
    useEffect(() => {
        if (selectedIcao24 && !planesDict[selectedIcao24] && !trackMode) {
            logger.info('UI', `Auto-deselect: ${selectedIcao24} left BBox (trackMode off)`);
            handleDeselectPlane();
        }
    }, [planesDict, selectedIcao24, trackMode, handleDeselectPlane]);

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
                syncViewport={syncViewport}
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
                <>
                    {/* Mobile backdrop — tap outside to close bottom drawer */}
                    <div className="sidebar-backdrop" onClick={handleDeselectPlane} />
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
                </>
            )}

            <PerformanceMonitor usageStats={usageStats} />

            {/* Dev Panel — Ctrl+D to toggle */}
            {showDevPanel && (
                <DevPanel
                    usageStats={usageStats}
                    apiStatus={apiStatus}
                    apiStats={apiStats}
                    latency={latency}
                    planeCount={planeCount}
                />
            )}
        </div>
    );
}
