import React, { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getAirlineLogoUrl, normalizeLongitude, predictPosition, latLngToGlobalPixels } from '../utils/flightUtils';
import { getAircraftIconUrl, getAircraftScale, getAltitudeColor } from '../utils/aircraftIcons';
import { trackStore } from '../store/FlightDataStore';
import { dataManager } from '../services/dataManager';
import HoverCard from './HoverCard';

/**
 * Custom Leaflet Canvas Layer for High-Performance Rendering
 */
const PlaneCanvasLayer = L.Layer.extend({
    onAdd: function (map) {
        this._map = map;
        this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated');
        this._canvas.style.pointerEvents = 'none'; // Let map handle clicks
        this._canvas.style.zIndex = 10;
        this.ctx = this._canvas.getContext('2d', { alpha: true });

        map.getPanes().overlayPane.appendChild(this._canvas);
        map.on('move', this._reset, this);
        map.on('resize', this._resize, this);
        if (map.options.zoomAnimation && L.Browser.any3d) {
            map.on('zoomanim', this._animateZoom, this);
        }
        this._reset();
    },
    onRemove: function (map) {
        map.getPanes().overlayPane.removeChild(this._canvas);
        map.off('move', this._reset, this);
        map.off('resize', this._resize, this);
        if (map.options.zoomAnimation) {
            map.off('zoomanim', this._animateZoom, this);
        }
    },
    _resize: function () {
        const size = this._map.getSize();
        this._canvas.width = size.x;
        this._canvas.height = size.y;
        this._reset();
    },
    _reset: function () {
        const size = this._map.getSize();
        this._canvas.width = size.x;
        this._canvas.height = size.y;

        // Critical Fix: Clear canvas immediately on move/reset before the next animation frame
        if (this.ctx) {
            this.ctx.clearRect(0, 0, size.x, size.y);
        }

        const topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, topLeft);
    },
    _animateZoom: function (e) {
        const scale = this._map.getZoomScale(e.zoom);
        const offset = this._map._latLngBoundsToNewLayerBounds(this._map.getBounds(), e.zoom, e.center).min;
        L.DomUtil.setTransform(this._canvas, offset, scale);
    },
    getCanvas: function () { return this._canvas; }
});

// ── FR24-Grade Zoom-Responsive Icon Sizing ──────────────────────────────────
// Two rendering tiers matching FlightRadar24 behavior:
//   Zoom 3-11 : Stable aircraft silhouette — NEVER shrinks to dots.
//               Density filtering (shouldShowPlane) controls clutter.
//   Zoom 12+  : Linear scale-up with full wingspan proportionality.
//
// `scale` is the wingspan-proportional factor from aircraftIcons (B738 = 1.0).
// Larger aircraft (B744, A380) render physically bigger at all zoom levels.

const FR24_BASE_PX = 36; // Base icon size — PlaneFinder reference
const TRAIL_LEN = 12;    // Ring buffer depth for gradient trail
const TRAIL_MIN_DIST_SQ = 0.000004; // ~2m² — skip duplicate trail points

function getDrawSize(plane, z, scale) {
    const s = Math.max(scale || 1.0, 0.2);

    if (z <= 9) {
        // PlaneFinder: nearly uniform at wide zoom — max ~1.2x ratio
        const compressed = Math.pow(s, 0.15);
        const clamped = Math.max(0.9, Math.min(1.1, compressed));
        return Math.round(FR24_BASE_PX * clamped);
    }

    if (z <= 11) {
        // Subtle differentiation emerges — max ~1.6x ratio
        const t = (z - 9) / 2; // 0→1 across z10-z11
        const exponent = 0.15 + t * 0.15;
        const compressed = Math.pow(s, exponent);
        const minC = 0.9 - t * 0.1;
        const maxC = 1.1 + t * 0.15;
        const clamped = Math.max(minC, Math.min(maxC, compressed));
        return Math.round(FR24_BASE_PX * clamped);
    }

    // z >= 12: full detail with zoom growth — max ~2x ratio
    const growthFactor = Math.pow(1.12, z - 11);
    const compressed = Math.pow(s, 0.35);
    const clamped = Math.max(0.7, Math.min(1.4, compressed));
    return Math.round(FR24_BASE_PX * clamped * growthFactor);
}

// Render mode flags for 60fps interaction optimization
const RENDER_MODE_FULL = 0;
const RENDER_MODE_SIMPLE = 1;

/**
 * MapView — 管理 Leaflet 地圖、飛機 markers、軌跡線、機場圖層
 * 使用原生 Leaflet（非 react-leaflet）以獲得對 marker 的完全控制
 */
export default function MapView({
    planesDict,
    selectedIcao24,
    trackPoints,
    flightHistoryRef,
    filters,
    selectedRoute,
    onSelectPlane,
    onDeselectPlane,
    onMapReady,
    onMapMove,
    onUsageUpdate,
    colorScheme = 'TACTICAL',
    mapLayer = 'dark',        // [v2.9.0] tile layer id
    trackMode = false,        // [v3.0] auto-follow selected plane
    playbackTime = null,      // [v3.1] UNIX timestamp for historical playback (null = live)
    t,
    translateMetar,
    syncViewport,
}) {
    const [hoveredPlane, setHoveredPlane] = useState(null);
    const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
    const [selectedFlightPath, setSelectedFlightPath] = useState(null); // Full session track for selected plane

    const mapContainerRef = useRef(null);
    const mapRef = useRef(null);
    const canvasLayerRef = useRef(null);
    const cachedPathsRef = useRef(new Map()); // Cache Path2D objects
    const routeLineRef = useRef(null);
    const flightPathAbortRef = useRef(null); // AbortController for session track fetch
    const selectedFlightPathRef = useRef(null); // Ref for animation loop access

    const predictiveLineRef = useRef(null);
    const animFrameRef = useRef(null);
    const lastDrawTimeRef = useRef(performance.now());
    const airportLayerRef = useRef(null);
    const airportMarkersLoadedRef = useRef(false);
    const airportMarkersMapRef = useRef(new Map());
    const tileLayerRef = useRef(null);     // [v2.9.0] current tile layer
    const trackModeRef = useRef(trackMode);  // [v3.0] ref for animation loop
    const playbackTimeRef = useRef(playbackTime); // [v3.1] ref for animation loop
    const trackPointsRef = useRef(trackPoints);   // [v3.1] ref for animation loop
    const onUsageUpdateRef = useRef(onUsageUpdate);
    const colorSchemeRef = useRef(colorScheme);
    const filtersRef = useRef(filters);

    // [Project AERO-SYNC] Zero-GC Projection Pre-allocation
    const sharedLatLngRef = useRef(new L.LatLng(0, 0));
    const sharedPointRef = useRef(new L.Point(0, 0));

    // [v3.0] Smart Tracking Interaction Refs
    const userInteractingRef = useRef(false);
    // [v6.0] FR24 Render Mode: track active pan/zoom for simplified rendering
    const renderModeRef = useRef(RENDER_MODE_FULL);
    const renderModeTimeoutRef = useRef(null);
    // [v6.0] ImageBitmap cache — pre-warmed offscreen bitmaps keyed by SVG URL
    const bitmapCacheRef = useRef(new Map());
    const idleTimeoutRef = useRef(null);

    useEffect(() => {
        trackModeRef.current = trackMode;
        if (trackMode) {
            userInteractingRef.current = false;
            if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
        }
    }, [trackMode]);

    useEffect(() => { playbackTimeRef.current = playbackTime; }, [playbackTime]);
    useEffect(() => { trackPointsRef.current = trackPoints; }, [trackPoints]);
    useEffect(() => { onUsageUpdateRef.current = onUsageUpdate; }, [onUsageUpdate]);
    useEffect(() => { colorSchemeRef.current = colorScheme; }, [colorScheme]);
    useEffect(() => { filtersRef.current = filters; }, [filters]);

    // ==========================================
    // 💧 軌跡自動注水 (Track Hydration Pipeline) [v4.2.1]
    // ==========================================
    useEffect(() => {
        // 確保有選中飛機，且歷史軌跡資料已載入
        if (!selectedIcao24 || !trackPoints || trackPoints.length === 0) return;
        if (!mapRef.current) return;

        console.log(`💧 [HYDRATION] Injecting ${trackPoints.length} historical points for ${selectedIcao24}`);

        // 1. 清空該飛機在繪圖引擎中的舊軌跡緩衝，避免殘影
        trackStore.clearTrack(selectedIcao24);

        const zoom = mapRef.current.getZoom();

        // 2. 投影並批次注入歷史軌跡點
        // 注意：trackPoints 格式為 [time, lat, lng, altitude, heading, velocity]
        trackPoints.forEach(point => {
            const [time, lat, lng] = point;

            // 投影轉換為繪圖引擎看得懂的全局像素座標
            const pixelPos = latLngToGlobalPixels(lat, lng, zoom);

            // 注入高效率繪圖引擎
            trackStore.addTrackPoint(selectedIcao24, lat, lng, pixelPos.x, pixelPos.y);
        });

        console.log(`✅ [HYDRATION] Track reconstruction complete for ${selectedIcao24}.`);

    }, [selectedIcao24, trackPoints]);

    const [airports, setAirports] = useState([]);
    const airportsRef = useRef([]);
    const [bounds, setBounds] = useState(null);

    // ===== 機場圖標 SVG =====
    function createAirportIcon(type) {
        const size = type === 'large' ? 14 : type === 'medium' ? 10 : 8;
        // Aero-Tactical Cyan: #22d3ee
        const svg = `
            <svg viewBox="0 0 24 24" width="${size * 2}" height="${size * 2}">
                <circle cx="12" cy="12" r="10" fill="none" stroke="#22d3ee" stroke-width="1.5" opacity="0.4"/>
                <circle cx="12" cy="12" r="4" fill="#22d3ee" shadow="0 0 8px #22d3ee"/>
            </svg>
        `.trim();
        return L.divIcon({ html: svg, className: 'airport-icon', iconSize: [size * 2, size * 2], iconAnchor: [size, size] });
    }

    // ===== 機場圖層初始化 =====
    const renderMetarPopup = async (ap, map, popup) => {
        try {
            const data = await dataManager.getMetar(ap.icao);

            if (data.error) {
                const noDataMsg = t('weatherData');
                popup.setContent(`<div class="ap-card"><div class="ap-name">${ap.name}</div><div class="ap-icao">${ap.icao}</div><div class="ap-no-data">${noDataMsg}</div></div>`);
                return;
            }

            const windDir = data.wdir === 'VRB' ? (translateMetar?.('Variable') || 'Variable') : `${data.wdir}°`;
            const windSpd = data.wspd || 0;
            const windDisplay = translateMetar?.(`${windDir} ${windSpd}kt`, 'WIND') || `${windDir} ${windSpd}kt`;
            const fltCatClass = data.fltCat === 'VFR' ? 'ap-vfr' : data.fltCat === 'MVFR' ? 'ap-mvfr' : 'ap-ifr';
            let cloudStr = data.clouds?.map(c => `${c.cover} ${c.base}ft`).join(', ') || '--';
            cloudStr = translateMetar?.(cloudStr, 'CLOUDS') || cloudStr;
            const elevM = data.elev ? Math.round(data.elev * 0.3048) : '--';
            const elevLabel = translateMetar?.('Elev') || 'Elev';
            const visibDisplay = translateMetar?.(`${data.visib ?? '--'} SM`, 'VISIB') || `${data.visib ?? '--'} SM`;
            const altimDisplay = translateMetar?.(`${data.altim ?? '--'} hPa`, 'ALTIM') || `${data.altim ?? '--'} hPa`;

            const localizedName = t('airportName', ap.icao) || ap.name;

            popup.setContent(`
                        <div class="ap-card">
                            <div class="ap-name">${localizedName}</div>
                            <div class="ap-icao">${ap.icao} · ${elevLabel} ${data.elev || '--'}ft (${elevM}m)</div>
                            <div class="ap-fltcat ${fltCatClass}">${data.fltCat || '--'}</div>
                            <div class="ap-grid">
                                <div class="ap-item">
                                    <div class="ap-label-row"><span class="ap-label">🌡</span><span class="ap-desc">${t('metarTemp')}:</span></div>
                                    <span class="ap-val">${data.temp ?? '--'}°C</span>
                                </div>
                                <div class="ap-item">
                                    <div class="ap-label-row"><span class="ap-label">💧</span><span class="ap-desc">${t('metarDew')}:</span></div>
                                    <span class="ap-val">${data.dewp ?? '--'}°C</span>
                                </div>
                                <div class="ap-item">
                                    <div class="ap-label-row"><span class="ap-label">🌬</span><span class="ap-desc">${t('metarWind')}:</span></div>
                                    <span class="ap-val">${windDisplay}</span>
                                </div>
                                <div class="ap-item">
                                    <div class="ap-label-row"><span class="ap-label">👁</span><span class="ap-desc">${t('metarVis')}:</span></div>
                                    <span class="ap-val">${visibDisplay}</span>
                                </div>
                                <div class="ap-item">
                                    <div class="ap-label-row"><span class="ap-label">☁</span><span class="ap-desc">${t('metarClouds')}:</span></div>
                                    <span class="ap-val" style="font-size: 11px;">${cloudStr}</span>
                                </div>
                                <div class="ap-item">
                                    <div class="ap-label-row"><span class="ap-label">📊</span><span class="ap-desc">${t('metarBaro')}:</span></div>
                                    <span class="ap-val">${altimDisplay}</span>
                                </div>
                            </div>
                            <div class="ap-metar">${data.rawOb || '--'}</div>
                        </div>
                    `);
        } catch (err) {
            popup.setContent(`<div class="ap-card"><div class="ap-name">${ap.name}</div><div class="ap-no-data">${t('weatherFailed')}</div></div>`);
        }
    };

    // ===== 初始化地圖 =====
    useEffect(() => {
        if (mapRef.current) return;

        const map = L.map(mapContainerRef.current, {
            zoomControl: false,
            minZoom: 3,
            worldCopyJump: true,
            dragging: true,
            tap: false,
            inertia: true,
            inertiaDeceleration: 3000,
            inertiaMaxSpeed: 2000,
            easeLinearity: 0.1
        }).setView([25.17, 121.44], 10);

        // [AERO-SYNC] 專業級游標：強制還原為 default，不使用 Leaflet 預設的 grab
        map.getContainer().style.cursor = 'default';

        // 加入右下角的縮放按鈕
        L.control.zoom({ position: 'bottomright' }).addTo(map);

        tileLayerRef.current = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19,
            attribution: '',
        }).addTo(map);

        // 初始 bounds
        setBounds(map.getBounds());

        // 加入 CanvasLayer
        const cLayer = new PlaneCanvasLayer();
        map.addLayer(cLayer);
        canvasLayerRef.current = cLayer;



        // [AERO-SYNC] 權重化命中偵測 (Weighted Hit Detection)
        map.on('click', (e) => {
            const clickPt = e.containerPoint;
            let candidates = [];

            const currentPlanes = planesDictRef.current || {};
            const currentSelected = selectedIcao24Ref.current;

            for (const id in currentPlanes) {
                const p = currentPlanes[id];
                if (!p.renderLat || !p.renderLng) continue;
                if (!shouldShowPlaneRef.current(p, 1.0)) continue;

                const pt = map.latLngToContainerPoint([p.renderLat, normalizeLongitude(p.renderLng)]);
                const dist = Math.hypot(pt.x - clickPt.x, pt.y - clickPt.y);

                const hitRadius = getDrawSize(p, map.getZoom(), getAircraftScale(p)) / 2 + 8;
                if (dist < hitRadius) {
                    // 計算命中權重 (Weight)
                    // 基礎權重為距離反比，加上顯著的業務權重
                    let weight = (hitRadius - dist);
                    if (id === currentSelected) weight += 50;  // 已選中者優先
                    if (p.isEmergency) weight += 100;         // 緊急狀態最高優先
                    if (p.category === 5 || p.category === 6) weight += 20; // 大型機優先

                    candidates.push({ id, plane: p, weight });
                }
            }

            if (candidates.length > 0) {
                // 排序並選擇權重最高者
                candidates.sort((a, b) => b.weight - a.weight);
                L.DomEvent.stopPropagation(e.originalEvent);
                onSelectPlane(candidates[0].id, candidates[0].plane);
            } else {
                onDeselectPlane();
            }
        });

        // [v3.0] Smart Tracking: Listen for user interactions to pause tracking
        // [v3.7 Fix] ONLY listen to direct physical user inputs, NOT Leaflet map state events (move/zoom)
        // because map.setView() triggers move/zoom and causes infinite loops.
        const handleInteractionStart = () => {
            userInteractingRef.current = true;
            if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
            // [v6.0] Enter simplified render mode during active interaction
            renderModeRef.current = RENDER_MODE_SIMPLE;
            if (renderModeTimeoutRef.current) clearTimeout(renderModeTimeoutRef.current);
        };
        const handleInteractionEnd = () => {
            if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
            idleTimeoutRef.current = setTimeout(() => {
                userInteractingRef.current = false;
            }, 10000); // Resume tracking after 10s of inactivity
            // [v6.0] Restore full render mode after interaction settles
            if (renderModeTimeoutRef.current) clearTimeout(renderModeTimeoutRef.current);
            renderModeTimeoutRef.current = setTimeout(() => {
                renderModeRef.current = RENDER_MODE_FULL;
            }, 150);
        };

        // Bind directly to the map container DOM elements to catch raw user inputs
        const container = map.getContainer();
        container.addEventListener('mousedown', handleInteractionStart);
        container.addEventListener('touchstart', handleInteractionStart);
        container.addEventListener('wheel', handleInteractionStart);

        container.addEventListener('mouseup', handleInteractionEnd);
        container.addEventListener('touchend', handleInteractionEnd);

        // Also listen to drag end specifically from leaflet
        map.on('dragend', handleInteractionEnd);

        // 地圖移動結束
        map.on('moveend', () => {
            const currentBounds = map.getBounds();
            setBounds(currentBounds);
            updateAirportVisibility(map);
            onMapMove?.();

            // [Project AERO-SYNC] Viewport-Driven Sync
            syncViewport?.({
                lamin: currentBounds.getSouth(),
                lomin: currentBounds.getWest(),
                lamax: currentBounds.getNorth(),
                lomax: currentBounds.getEast()
            });
        });

        // [AERO-SYNC] 僅在縮放結束時更新全局投影快取
        map.on('zoomend', () => {
            updateAllProjectionCaches(map);
            updateAirportVisibility(map);

            const currentBounds = map.getBounds();
            syncViewport?.({
                lamin: currentBounds.getSouth(),
                lomin: currentBounds.getWest(),
                lamax: currentBounds.getNorth(),
                lomax: currentBounds.getEast()
            });
        });

        // [AERO-SYNC] 動態懸停游標 (Dynamic Hover Pointer)
        map.on('mousemove', (e) => {
            const currentPlanes = planesDictRef.current || {};
            const mousePt = e.containerPoint;
            let found = false;
            let foundPlane = null;

            for (const id in currentPlanes) {
                const p = currentPlanes[id];
                if (!p.renderLat || !p.renderLng) continue;
                if (!shouldShowPlaneRef.current(p, 1.0)) continue;

                const pt = map.latLngToContainerPoint([p.renderLat, normalizeLongitude(p.renderLng)]);
                const dist = Math.hypot(pt.x - mousePt.x, pt.y - mousePt.y);
                const hoverRadius = getDrawSize(p, map.getZoom(), getAircraftScale(p)) / 2 + 4;
                if (dist < hoverRadius) {
                    found = true;
                    foundPlane = p;
                    break;
                }
            }
            map.getContainer().style.cursor = found ? 'pointer' : 'default';

            // [Project AERO-SYNC] Update hover box visibility
            if (foundPlane) {
                setHoveredPlane(foundPlane);
                setHoverPos({ x: mousePt.x, y: mousePt.y });
            } else {
                setHoveredPlane(null);
            }
        });

        mapRef.current = map;

        // [AERO-SYNC] 確保初始化即校正 (Initial Warmup)
        // 解決啟動時因為 zoom 不匹配導致的白畫面
        setTimeout(() => {
            if (mapRef.current) {
                updateAllProjectionCaches(mapRef.current);
                updateAirportVisibility(mapRef.current);
            }
        }, 100);

        onMapReady?.(map);

        // [Project AERO-SYNC] L3 Persistent Airport Loading
        dataManager.getAirports().then(data => {
            console.log(`🌍 [DataManager] Loaded ${data.length} airports`);
            airportsRef.current = data;
            setAirports(data);
        }).catch(err => console.error('Failed to load airports:', err));

        airportLayerRef.current = L.layerGroup();
        updateAirportVisibility(map);

        return () => {
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
            map.off('mousemove');
            map.off('zoomend');
            map.off('moveend');
            map.off('click');
            map.remove();
            mapRef.current = null;
        };
    }, []);

    // ===== 視覺密度控制配置 (v2.3.1) =====
    const TIER1_AIRPORTS = ['RCTP', 'RCSS', 'RJTT', 'VHHH', 'WSSS', 'KJFK', 'EGLL', 'LFPG', 'EDDF', 'RJAA', 'RKSI', 'ZSPD', 'ZGGG', 'VTBS', 'OMDB', 'KLAX', 'KSFO', 'YSSY'];

    // 確定性隨機分數 (ICAO24 HEX -> 0~1)
    const getPlaneHashScore = (icao24) => {
        if (!icao24) return 0;
        return parseInt(icao24, 16) / 0xFFFFFF;
    };

    // [OPT 2.1] Airport diff-update: only add/remove changed markers instead of full clear+rebuild
    function updateAirportVisibility(map) {
        if (!map || !airportLayerRef.current) return;
        const zoom = map.getZoom();
        const bounds = map.getBounds();
        const currentAirports = airportsRef.current || [];
        const currentFilters = filtersRef.current || {};
        const showTier1 = zoom >= 7;
        const showTier2 = zoom >= 8;
        const showTier3 = zoom >= 9;
        const existingMarkers = airportMarkersMapRef.current;

        if (!showTier1 || !currentFilters.showAirports) {
            if (map.hasLayer(airportLayerRef.current)) {
                airportLayerRef.current.clearLayers();
                existingMarkers.clear();
                map.removeLayer(airportLayerRef.current);
            }
            return;
        }

        if (!map.hasLayer(airportLayerRef.current)) {
            map.addLayer(airportLayerRef.current);
        }

        const extBounds = bounds.pad(0.3);

        // Build set of desired visible airport keys
        const desiredKeys = new Set();
        for (let i = 0; i < currentAirports.length; i++) {
            const ap = currentAirports[i];
            const isTier1 = TIER1_AIRPORTS.includes(ap.icao);
            const isTier2 = ap.iata && ap.iata.length === 3;
            let visible = isTier1 ? showTier1 : isTier2 ? showTier2 : showTier3;
            if (visible && extBounds.contains([ap.lat, ap.lng])) {
                desiredKeys.add(ap.icao || ap.iata || `idx_${i}`);
            }
        }

        // Remove markers that are no longer desired
        for (const [key, marker] of existingMarkers) {
            if (!desiredKeys.has(key)) {
                airportLayerRef.current.removeLayer(marker);
                existingMarkers.delete(key);
            }
        }

        // Add new markers that don't exist yet
        for (let i = 0; i < currentAirports.length; i++) {
            const ap = currentAirports[i];
            const isTier1 = TIER1_AIRPORTS.includes(ap.icao);
            const isTier2 = ap.iata && ap.iata.length === 3;
            const key = ap.icao || ap.iata || `idx_${i}`;
            if (!desiredKeys.has(key) || existingMarkers.has(key)) continue;

            const m = L.marker([ap.lat, ap.lng], {
                icon: createAirportIcon(isTier1 ? 'large' : isTier2 ? 'medium' : 'small'),
                interactive: true,
                zIndexOffset: isTier1 ? 100 : isTier2 ? 50 : 0,
            });

            const labelName = ap.city && ap.city !== ap.name?.toUpperCase() ? `${ap.name} (${ap.city})` : ap.name;
            m.bindTooltip(`${ap.icao} - ${labelName}`, {
                permanent: false, direction: 'right', offset: [10, 0], className: 'airport-label',
            });

            m.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                const popup = L.popup({ maxWidth: 320, className: 'airport-popup' }).setLatLng([ap.lat, ap.lng]);
                popup.setContent(`<div class="ap-loading">${t('scanning')} ${ap.icao}...</div>`);
                popup.openOn(map);
                renderMetarPopup(ap, map, popup);
            });

            m.addTo(airportLayerRef.current);
            existingMarkers.set(key, m);
        }
    }

    // 監聽 showAirports filter 與 語系 (t) 變化
    useEffect(() => {
        filtersRef.current = filters; // Update ref whenever filters change
        const map = mapRef.current;
        if (map) {
            updateAirportVisibility(map);
        }
    }, [airports, filters, t, translateMetar]);

    // [v2.9.0] Tile layer swap
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const TILE_URLS = {
            dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
            satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            street: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
            terrain: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
        };
        const url = TILE_URLS[mapLayer] || TILE_URLS.dark;
        if (tileLayerRef.current) {
            tileLayerRef.current.setUrl(url);
        }
    }, [mapLayer]);

    // [v3.0] Track mode: update ref so animation loop sees latest value
    useEffect(() => {
        trackModeRef.current = trackMode;
    }, [trackMode]);


    // [Project AERO-SYNC] Zero-GC Pure Math Projector (Global Space Version)
    const updateAllProjectionCaches = useCallback((map) => {
        if (!map) return;

        const zoom = map.getZoom();
        const worldSize = 256 * Math.pow(2, zoom);

        // --- 預先計算投影常數 ---
        const scaleX = worldSize / 360;
        const scaleY = worldSize / (2 * Math.PI);
        const halfWorld = worldSize / 2;
        const radConst = Math.PI / 360;

        const outPoint = sharedPointRef.current;

        /**
         * 淨化後的投影函式：只產生「全域像素座標 (Global Pixels)」
         * 不再減去 origin，確保拖曳時不需要更新快取
         */
        const pureMathProjector = (lat, lng) => {
            // X 軸投影 (簡單線性)
            const xGlobal = (normalizeLongitude(lng) + 180) * scaleX;

            // Y 軸投影 (Web Mercator 弧度轉換)
            // latRad = lat * Math.PI / 180;
            // y = halfWorld - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * scaleY;
            const yGlobal = halfWorld - Math.log(Math.tan(Math.PI / 4 + lat * radConst)) * scaleY;

            // 轉換為 Container 像素座標 (減去當前地圖物理原點)
            outPoint.x = xGlobal;
            outPoint.y = yGlobal;
            return outPoint;
        };

        trackStore.updateProjectionCache(pureMathProjector);

        // [Project AERO-SYNC] 同步更新所有即時飛機的全域座標 (In-place)
        const currentPlanes = planesDictRef.current;
        for (const id in currentPlanes) {
            const p = currentPlanes[id];
            if (p.renderLat && p.renderLng) {
                const pt = pureMathProjector(p.renderLat, p.renderLng);
                p.globalX = pt.x;
                p.globalY = pt.y;
            }
        }
    }, [sharedPointRef]);
    const shouldShowPlane = useCallback(
        (plane, dynamicThrottle = 1.0) => {
            if (!filters.showGround && plane.onGround) return false;
            if (!filters.showEmergency && plane.isEmergency) return false;
            const alt = parseFloat(plane.altitude);
            // Low-altitude filter is handled by density LOD, not a hard cutoff

            // [v3.1] Airline Fleet Focus Mode
            if (filters.fleetFocus && (!plane.callsign || !plane.callsign.startsWith(filters.fleetFocus))) return false;

            // [v4.0] Use live map bounds - never stale
            const liveMap = mapRef.current;
            if (liveMap) {
                const liveBounds = liveMap.getBounds();
                if (liveBounds) {
                    const lat = parseFloat(plane.lat);
                    const lng = parseFloat(plane.lng);
                    // Add extra 20% padding to avoid clipping planes near edges
                    const latPad = (liveBounds.getNorth() - liveBounds.getSouth()) * 0.2;
                    const lngPad = (liveBounds.getEast() - liveBounds.getWest()) * 0.2;
                    if (lat < liveBounds.getSouth() - latPad || lat > liveBounds.getNorth() + latPad ||
                        lng < liveBounds.getWest() - lngPad || lng > liveBounds.getEast() + lngPad) {
                        return false;
                    }
                }
            }

            // [v2.3.6] 動態密度過濾器 (Deterministic Hash)
            const map = mapRef.current;
            if (map && !plane.isEmergency && plane.icao24 !== selectedIcao24) {
                const zoom = map.getZoom();
                const score = getPlaneHashScore(plane.icao24);

                // 密度門檻設定 (v2.3.7 重新平衡：更為慷慨)
                const densityTable = {
                    1: 0.10, 2: 0.20,
                    3: 0.35, 4: 0.50,
                    5: 0.70, 6: 0.85,
                    7: 0.95, 8: 1.0,
                };

                let threshold = densityTable[zoom] ?? 1.0;

                // [v2.3.6] 結合總數判定：如果當前 BBox 感知到的飛機總數過多，額外縮減 threshold
                threshold *= dynamicThrottle;

                if (score > threshold) return false;
            }

            // LOD 優化 (v2.3.7 放寬低空限制)
            if (map) {
                const zoom = map.getZoom();
                // Zoom < 4 隱藏 2500ft 以下
                if (zoom < 4 && (plane.onGround || plane.altitude < 760)) {
                    return false;
                }
                // Zoom 4-5 隱藏地面
                if (zoom >= 4 && zoom < 6 && plane.onGround) {
                    return false;
                }
            }

            return true;
        },
        [filters, bounds, selectedIcao24]
    );



    // [v2.8.0] Keep refs of mutable props for the persistent animation loop (avoids stale closures)
    const planesDictRef = useRef(planesDict);
    useEffect(() => { planesDictRef.current = planesDict; }, [planesDict]);

    const selectedIcao24Ref = useRef(selectedIcao24);
    useEffect(() => { selectedIcao24Ref.current = selectedIcao24; }, [selectedIcao24]);

    // [v3.2] Keep shouldShowPlane accessible for the pointer click event
    const shouldShowPlaneRef = useRef(shouldShowPlane);
    useEffect(() => { shouldShowPlaneRef.current = shouldShowPlane; }, [shouldShowPlane]);

    // ── Full Session Track Fetch ──────────────────────────────────────
    // When a plane is selected, fetch its ACTIVE session's full track from the API.
    // On deselect, abort any pending fetch and clear the path.
    useEffect(() => {
        // Abort previous fetch
        if (flightPathAbortRef.current) {
            flightPathAbortRef.current.abort();
            flightPathAbortRef.current = null;
        }

        if (!selectedIcao24) {
            setSelectedFlightPath(null);
            selectedFlightPathRef.current = null;
            return;
        }

        const controller = new AbortController();
        flightPathAbortRef.current = controller;

        (async () => {
            try {
                // 1. Find the active session for this aircraft
                const sessRes = await fetch(`/api/sessions/${selectedIcao24}?status=ACTIVE&limit=1`, { signal: controller.signal });
                if (!sessRes.ok) return;
                const sessions = await sessRes.json();
                if (!sessions.length) return;

                const sessionId = sessions[0].sessionId;

                // 2. Fetch full track for this session
                const trackRes = await fetch(`/api/session/${sessionId}/track`, { signal: controller.signal });
                if (!trackRes.ok) return;
                const data = await trackRes.json();

                if (data.path && data.path.length > 1) {
                    // path format: [[timestamp, lat, lng, altitude, heading, velocity, onGround], ...]
                    selectedFlightPathRef.current = data.path;
                    setSelectedFlightPath(data.path);
                }
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.warn('[FlightPath] Failed to fetch session track:', err.message);
                }
            }
        })();

        return () => controller.abort();
    }, [selectedIcao24]);

    // [v4.1.2] Unified Selection & Camera Focus Effect
    useEffect(() => {
        if (selectedIcao24) {
            userInteractingRef.current = false;
            if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
        }
    }, [selectedIcao24]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !selectedIcao24 || !planesDict[selectedIcao24]) return;

        // [v3.4 Fix] Respect user panning. DO NOT force camera if user is currently interacting.
        if (userInteractingRef.current) return;

        const plane = planesDict[selectedIcao24];
        const lat = plane.renderLat || plane.lat;
        const lng = plane.renderLng || plane.lng;

        const targetLatLng = L.latLng(lat, lng);
        const targetZoom = Math.max(map.getZoom(), 10);

        // Prevent setting state and getting stuck if the map is already there
        if (map.getCenter().distanceTo(targetLatLng) < 5 && map.getZoom() === targetZoom) {
            return;
        }

        map.setView(targetLatLng, targetZoom, { animate: true });
    }, [selectedIcao24, planesDict]);

    // ===== 動畫引擎與 Canvas 渲染 (Project AERO-SYNC) =====
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        // [v6.0] Dual-layer icon cache: HTMLImageElement + ImageBitmap (offscreen)
        // SVG → Image (immediate) → ImageBitmap (async, zero-decode on draw)
        const getSVGImage = (plane) => {
            const url = getAircraftIconUrl(plane);
            if (!cachedPathsRef.current.has(url)) {
                const img = new Image();
                img.src = url;
                cachedPathsRef.current.set(url, img);
                // Pre-warm ImageBitmap once the Image decodes
                img.decode?.().then(() => {
                    if (typeof createImageBitmap === 'function' && img.naturalWidth > 0) {
                        createImageBitmap(img).then(bmp => {
                            bitmapCacheRef.current.set(url, bmp);
                        }).catch(() => {});
                    }
                }).catch(() => {});
            }
            // Prefer ImageBitmap (GPU-ready), fall back to HTMLImageElement
            return bitmapCacheRef.current.get(url) || cachedPathsRef.current.get(url);
        };

        // [v3.4] Airline Logo Cache for Canvas
        const getLogoImage = (callsign) => {
            const logoUrl = getAirlineLogoUrl(callsign);
            if (!logoUrl) return null;
            if (!cachedPathsRef.current.has(logoUrl)) {
                const img = new Image();
                img.src = logoUrl;
                cachedPathsRef.current.set(logoUrl, img);
            }
            return cachedPathsRef.current.get(logoUrl);
        };

        function animate(time) {
            const currentPlanes = planesDictRef.current || {};
            const currentSelected = selectedIcao24Ref.current;
            const pbTime = playbackTimeRef.current;
            let isPlaybackActive = false;

            // Calculate a safe delta-time for animations, capped at 100ms
            // to prevent "teleportation" after switching tabs
            const nowMs = performance.now();
            const rawDt = nowMs - lastDrawTimeRef.current;
            const dt = Math.min(rawDt, 100) / 1000; // in seconds
            lastDrawTimeRef.current = nowMs;

            // Update Positions with Interpolation (Phase 8)
            Object.keys(currentPlanes).forEach(id => {
                const plane = currentPlanes[id];
                const currentLat = plane.renderLat || plane.lat;
                const currentLng = plane.renderLng || plane.lng;

                // 基礎插值速度 (Lerp): 0.5 秒內滑向目標，確保 60 FPS 平滑度
                const lerpFactor = 0.5;

                if (plane.onGround || plane.velocity <= 0 || plane.altitude === 'GROUND') {
                    if (plane.targetLat && plane.targetLng) {
                        plane.renderLat = currentLat + (plane.targetLat - currentLat) * lerpFactor;
                        plane.renderLng = currentLng + (plane.targetLng - currentLng) * lerpFactor;
                    }
                } else if (plane.targetLat && plane.targetLng) {
                    // Micro-Dead Reckoning + Lerp
                    if (!plane.simTime) {
                        plane.simTime = plane.lastContact || (plane.targetUpdatedAt ? plane.targetUpdatedAt / 1000 : Date.now() / 1000);
                    }
                    plane.simTime += dt;

                    const anchorSec = plane.lastContact || (plane.targetUpdatedAt ? plane.targetUpdatedAt / 1000 : Date.now() / 1000);
                    const elapsedSec = Math.min(plane.simTime - anchorSec, 120);

                    const predictedPos = predictPosition(plane.targetLat, plane.targetLng, plane.velocity, plane.heading, Math.max(0, elapsedSec));

                    // 平滑追趕 (Phase 8: Smooth Glide)
                    plane.renderLat = currentLat + (predictedPos.lat - currentLat) * lerpFactor;
                    plane.renderLng = currentLng + (predictedPos.lng - currentLng) * lerpFactor;

                    if (plane.targetUpdatedAt && dt === 0.1) {
                        plane.simTime = plane.targetUpdatedAt / 1000;
                    }
                } else {
                    plane.renderLat = plane.lat;
                    plane.renderLng = plane.lng;
                }
            });

            // ── Trail Ring Buffer Recording ─────────────────────────────
            // After interpolation, record each plane's position into a
            // lightweight ring buffer for the gradient trail effect.
            Object.keys(currentPlanes).forEach(id => {
                const plane = currentPlanes[id];
                const lat = plane.renderLat;
                const lng = plane.renderLng;
                if (!lat || !lng) return;

                // Lazy-init ring buffer
                if (!plane._trail) {
                    plane._trail = new Float64Array(TRAIL_LEN * 2); // [lat0,lng0,lat1,lng1,...]
                    plane._trailHead = 0;
                    plane._trailCount = 0;
                    // Seed with current position
                    plane._trail[0] = lat;
                    plane._trail[1] = lng;
                    plane._trailCount = 1;
                    return;
                }

                // Check distance from last recorded point to avoid duplicates
                const prevIdx = ((plane._trailHead + TRAIL_LEN - 1) % TRAIL_LEN) * 2;
                const dLat = lat - plane._trail[prevIdx];
                const dLng = lng - plane._trail[prevIdx + 1];
                if (dLat * dLat + dLng * dLng < TRAIL_MIN_DIST_SQ) return;

                // Write new point at head
                const writeIdx = plane._trailHead * 2;
                plane._trail[writeIdx] = lat;
                plane._trail[writeIdx + 1] = lng;
                plane._trailHead = (plane._trailHead + 1) % TRAIL_LEN;
                if (plane._trailCount < TRAIL_LEN) plane._trailCount++;
            });

            // Playback override for selected plane
            if (pbTime !== null && currentSelected && currentPlanes[currentSelected]) {
                const pts = trackPointsRef.current;
                if (pts && pts.length >= 2) {
                    let lo = 0, hi = pts.length - 1;
                    while (lo < hi - 1) {
                        const mid = Math.floor((lo + hi) / 2);
                        if (pts[mid][0] <= pbTime) lo = mid;
                        else hi = mid;
                    }
                    const p0 = pts[lo];
                    const p1 = pts[hi];
                    let lat, lng;
                    if (p1[0] === p0[0]) {
                        lat = p0[1]; lng = p0[2];
                    } else {
                        const t = Math.max(0, Math.min(1, (pbTime - p0[0]) / (p1[0] - p0[0])));
                        lat = p0[1] + (p1[1] - p0[1]) * t;
                        lng = p0[2] + (p1[2] - p0[2]) * t;
                    }
                    currentPlanes[currentSelected].renderLat = lat;
                    currentPlanes[currentSelected].renderLng = lng;
                    isPlaybackActive = true;
                }
            }

            // Smart Camera Pan
            if (currentSelected && currentPlanes[currentSelected] && trackModeRef.current && !userInteractingRef.current) {
                const sp = currentPlanes[currentSelected];
                map.panTo([sp.renderLat, sp.renderLng], { animate: true, duration: isPlaybackActive ? 0.1 : 0.3, easeLinearity: 0.5 });
            }

            // === Canvas Drawing Phase ===
            if (canvasLayerRef.current) {
                const canvas = canvasLayerRef.current.getCanvas();
                const ctx = canvasLayerRef.current.ctx;
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                const zoom = map.getZoom();

                // [v4.0] 獲取當前即時相機邊界原點 (Dynamic Camera Tracking)
                // 使用 getPixelBounds().min 取代 getPixelOrigin()，解決拖曳時的殘影與位移
                const pixelBounds = map.getPixelBounds();
                const ox = pixelBounds.min.x;
                const oy = pixelBounds.min.y;

                // --- [Phase 8] Batch Track Rendering Phase (Spline Version) ---
                if (zoom >= 6) {
                    ctx.save();
                    ctx.lineWidth = 2.5;
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';

                    trackStore.forEachTrack((icao24, getPoints) => {
                        const plane = currentPlanes[icao24];
                        if (icao24 !== selectedIcao24Ref.current || !plane) return;

                        ctx.beginPath();
                        ctx.strokeStyle = '#22d3ee'; // Tactician Cyan

                        let points = [];
                        getPoints((lat, lng, gx, gy) => {
                            points.push({ x: gx - ox, y: gy - oy });
                        });

                        if (points.length < 2) return;

                        // [Phase 8] Quadratic Bezier Spline 繪製
                        // 使用中點作為控制點，達成 C1 連續性 (滑順轉彎)
                        ctx.moveTo(points[0].x, points[0].y);

                        let i;
                        for (i = 1; i < points.length - 1; i++) {
                            // 檢查是否跨越經度線 (Antimeridian protection)
                            if (Math.abs(points[i].x - points[i - 1].x) > canvas.width / 2) {
                                ctx.stroke();
                                ctx.beginPath();
                                ctx.moveTo(points[i].x, points[i].y);
                                continue;
                            }

                            const xc = (points[i].x + points[i + 1].x) / 2;
                            const yc = (points[i].y + points[i + 1].y) / 2;
                            ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
                        }
                        // 畫最後一條線段到飛機當前預估位置 (renderLat/Lng)
                        const lastP = points[points.length - 1]; // [Fix 8.1] 確保抓到最後一點
                        const planePt = latLngToGlobalPixels(plane.renderLat, plane.renderLng, zoom);
                        const px = planePt.x - ox;
                        const py = planePt.y - oy;

                        if (Math.abs(px - lastP.x) < canvas.width / 2) {
                            ctx.lineTo(px, py);
                        }

                        ctx.stroke();

                    });
                    ctx.restore();
                }

                // ── Full Session Flight Path (Altitude-Colored) ──────────────
                // Draw the complete historical track for the selected plane's active session.
                // Each segment is individually colored by average altitude of its two endpoints.
                const flightPath = selectedFlightPathRef.current;
                if (flightPath && flightPath.length > 1 && currentSelected) {
                    ctx.save();
                    ctx.lineWidth = zoom >= 12 ? 3 : 2;
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    ctx.globalAlpha = 0.85;

                    // Pre-project all points to container coordinates
                    // path format: [timestamp, lat, lng, altitude, heading, velocity, onGround]
                    let prevPt = null;
                    let prevAlt = 0;

                    for (let pi = 0; pi < flightPath.length; pi++) {
                        const seg = flightPath[pi];
                        const lat = seg[1];
                        const lng = seg[2];
                        const alt = seg[3] || 0;

                        const pt = map.latLngToContainerPoint([lat, normalizeLongitude(lng)]);

                        if (prevPt) {
                            // Skip antimeridian jumps
                            if (Math.abs(pt.x - prevPt.x) < canvas.width / 2) {
                                const avgAlt = (prevAlt + alt) / 2;
                                ctx.strokeStyle = getAltitudeColor(avgAlt);
                                ctx.beginPath();
                                ctx.moveTo(prevPt.x, prevPt.y);
                                ctx.lineTo(pt.x, pt.y);
                                ctx.stroke();
                            }
                        }

                        prevPt = pt;
                        prevAlt = alt;
                    }

                    // Draw final segment to the plane's current live position
                    const livePlane = currentPlanes[currentSelected];
                    if (prevPt && livePlane && livePlane.renderLat) {
                        const livePt = map.latLngToContainerPoint([livePlane.renderLat, normalizeLongitude(livePlane.renderLng)]);
                        if (Math.abs(livePt.x - prevPt.x) < canvas.width / 2) {
                            const liveAlt = livePlane.altitude || prevAlt;
                            ctx.strokeStyle = getAltitudeColor((prevAlt + liveAlt) / 2);
                            ctx.beginPath();
                            ctx.moveTo(prevPt.x, prevPt.y);
                            ctx.lineTo(livePt.x, livePt.y);
                            ctx.stroke();
                        }
                    }

                    ctx.restore();
                }

                // [v6.0] FR24 Render Mode & Limits
                const isSimple = renderModeRef.current === RENDER_MODE_SIMPLE;
                const maxDraw = isSimple
                    ? (zoom <= 6 ? 200 : 800)   // Simplified: fewer planes during interaction
                    : (zoom <= 4 ? 300 : zoom <= 5 ? 800 : zoom <= 6 ? 1500 : zoom <= 7 ? 3500 : zoom <= 8 ? 6000 : 10000);
                let drawnCount = 0;

                ctx.textBaseline = 'middle';

                // [v7.0] Frustum Culling — lat/lng pre-filter before projection
                const vb = map.getBounds();
                const CULL_PAD = 0.5; // degrees buffer to avoid edge pop-in
                const cullS = vb.getSouth() - CULL_PAD;
                const cullN = vb.getNorth() + CULL_PAD;
                const cullW = vb.getWest() - CULL_PAD;
                const cullE = vb.getEast() + CULL_PAD;

                // Build render queue
                const renderQueue = [];
                for (const id in currentPlanes) {
                    const plane = currentPlanes[id];
                    if (!plane.renderLat || !plane.renderLng) continue;
                    // Fast lat/lng frustum cull — skip projection entirely for off-screen planes
                    const pLat = plane.renderLat;
                    const pLng = plane.renderLng;
                    if (pLat < cullS || pLat > cullN || pLng < cullW || pLng > cullE) continue;
                    if (!shouldShowPlaneRef.current(plane, 1.0)) continue;
                    renderQueue.push(plane);
                }

                if (renderQueue.length > maxDraw) {
                    renderQueue.sort((a, b) => {
                        if (a.icao24 === currentSelected) return -1;
                        if (b.icao24 === currentSelected) return 1;
                        if (a.isEmergency && !b.isEmergency) return -1;
                        if (!a.onGround && b.onGround) return -1;
                        return 0;
                    });
                }

                // ── Label Collision Grid ──────────────────────────────────
                // Spatial hash for O(1) label overlap detection.
                // Grid cell = 60×30 px — slightly larger than a typical label bubble.
                const CELL_W = 60;
                const CELL_H = 30;
                const gridCols = Math.ceil(canvas.width / CELL_W) + 1;
                const gridRows = Math.ceil(canvas.height / CELL_H) + 1;
                const labelGrid = new Uint8Array(gridCols * gridRows); // 0=free, 1=occupied

                function labelFits(absX, absY, w, h) {
                    const c0 = Math.max(0, Math.floor(absX / CELL_W));
                    const c1 = Math.min(gridCols - 1, Math.floor((absX + w) / CELL_W));
                    const r0 = Math.max(0, Math.floor(absY / CELL_H));
                    const r1 = Math.min(gridRows - 1, Math.floor((absY + h) / CELL_H));
                    for (let r = r0; r <= r1; r++) {
                        for (let c = c0; c <= c1; c++) {
                            if (labelGrid[r * gridCols + c]) return false;
                        }
                    }
                    // Claim cells
                    for (let r = r0; r <= r1; r++) {
                        for (let c = c0; c <= c1; c++) {
                            labelGrid[r * gridCols + c] = 1;
                        }
                    }
                    return true;
                }

                // ── FR24-Grade Plane Render Loop ─────────────────────────────
                for (let i = 0; i < Math.min(maxDraw, renderQueue.length); i++) {
                    const plane = renderQueue[i];

                    const pt = map.latLngToContainerPoint([plane.renderLat, normalizeLongitude(plane.renderLng)]);
                    const ptX = pt.x;
                    const ptY = pt.y;

                    // Frustum culling
                    if (ptX < -100 || ptX > canvas.width + 100 || ptY < -100 || ptY > canvas.height + 100) continue;

                    drawnCount++;
                    const isSelected = plane.icao24 === currentSelected;

                    // Data age → opacity
                    const dataAge = (nowMs / 1000) - (plane.lastContact || (nowMs / 1000));
                    let opacity = 1.0;
                    if (dataAge > 60) opacity = 0.4;
                    else if (dataAge > 30) opacity = 0.7;

                    // ── Gradient Trail ──────────────────────────────────
                    if (plane._trailCount > 1 && !plane.onGround && !isSimple) {
                        const tc = plane._trailCount;
                        const head = plane._trailHead;
                        const trail = plane._trail;
                        const trailColor = getAltitudeColor(plane.altitude);

                        ctx.save();
                        ctx.lineCap = 'round';
                        ctx.lineJoin = 'round';
                        ctx.lineWidth = zoom >= 12 ? 2.5 : 1.8;
                        ctx.shadowColor = trailColor;
                        ctx.shadowBlur = 3;

                        // Walk from oldest → newest, drawing segments with increasing alpha
                        for (let ti = 0; ti < tc - 1; ti++) {
                            const fromIdx = ((head - tc + ti + TRAIL_LEN) % TRAIL_LEN) * 2;
                            const toIdx = ((head - tc + ti + 1 + TRAIL_LEN) % TRAIL_LEN) * 2;

                            const fromPt = map.latLngToContainerPoint([trail[fromIdx], normalizeLongitude(trail[fromIdx + 1])]);
                            const toPt = map.latLngToContainerPoint([trail[toIdx], normalizeLongitude(trail[toIdx + 1])]);

                            // Skip antimeridian jumps
                            if (Math.abs(toPt.x - fromPt.x) > canvas.width / 2) continue;

                            const segAlpha = opacity * ((ti + 1) / tc) * 0.7;
                            ctx.globalAlpha = segAlpha;
                            ctx.strokeStyle = trailColor;
                            ctx.beginPath();
                            ctx.moveTo(fromPt.x, fromPt.y);
                            ctx.lineTo(toPt.x, toPt.y);
                            ctx.stroke();
                        }

                        ctx.restore();
                    }

                    // ── Aircraft Silhouette (All Zoom Levels) ──
                    const scale = getAircraftScale(plane);
                    const drawSize = getDrawSize(plane, zoom, scale);

                    ctx.save();
                    ctx.globalAlpha = opacity;
                    ctx.translate(ptX, ptY);

                    // FR24 yellow shadow glow
                    if (isSelected) {
                        ctx.shadowColor = '#22d3ee';
                        ctx.shadowBlur = 15;
                    } else if (plane.isEmergency) {
                        ctx.shadowColor = '#ef4444';
                        ctx.shadowBlur = 10;
                    } else {
                        ctx.shadowColor = plane.onGround ? 'rgba(100,100,100,0.4)' : 'rgba(245,194,17,0.5)';
                        ctx.shadowBlur = plane.onGround ? 2 : 4;
                    }

                    // Heading rotation (SVG is North-Up)
                    const finalRotationRad = (plane.heading || 0) * Math.PI / 180;
                    ctx.rotate(finalRotationRad);

                    // Draw aircraft icon (prefer ImageBitmap → HTMLImageElement)
                    const img = getSVGImage(plane);
                    const imgReady = img && (img instanceof ImageBitmap || (img.complete && img.naturalHeight !== 0));
                    if (imgReady) {
                        const offset = drawSize / 2;
                        ctx.drawImage(img, -offset, -offset, drawSize, drawSize);
                    }

                    ctx.restore();

                    // ── Label Rendering ──────────────────────────────────────
                    // Selected: always show. Emergency: zoom >= 10. Normal: fade-in at zoom >= 12
                    const shouldShowLabel = isSelected
                        || (zoom >= 10 && plane.isEmergency)
                        || (zoom >= 12 && !isSimple);

                    if (shouldShowLabel) {
                        // Compute label opacity for fade-in effect at zoom 12-13
                        let labelAlpha = opacity;
                        if (!isSelected && !plane.isEmergency && zoom < 13) {
                            labelAlpha *= (zoom - 11); // 0→1 fade over zoom 12-13
                        }

                        const logoImg = getLogoImage(plane.callsign);
                        const hasLogo = logoImg && logoImg.complete && logoImg.naturalWidth > 0;

                        // Build label text: callsign + altitude at high zoom
                        let labelText = plane.callsign || plane.icao24?.slice(0, 6) || '';
                        if (zoom >= 13 && !plane.onGround && plane.altitude > 0) {
                            const altFL = Math.round(plane.altitude * 3.28084 / 100);
                            labelText += ` FL${altFL}`;
                        }

                        ctx.font = 'bold 13px "JetBrains Mono", "Roboto Mono", Inter, sans-serif';
                        const textWidth = ctx.measureText(labelText).width;

                        const logoWidth = hasLogo ? 40 : 0;
                        const logoHeight = 14;
                        const paddingX = 10;
                        const gap = hasLogo ? 8 : 0;

                        const bubbleWidth = paddingX + logoWidth + gap + textWidth + paddingX;
                        const bubbleHeight = 28;
                        const radius = 6;
                        const boxX = Math.round(drawSize / 2) + 6;
                        const boxY = -bubbleHeight / 2;
                        const tailWidth = 8;
                        const tailHeight = 10;

                        // ── Label Collision Check ──
                        // Selected/Emergency always claim+draw; normal labels skip on overlap
                        const labelAbsX = ptX + boxX;
                        const labelAbsY = ptY + boxY;
                        const canDraw = isSelected || plane.isEmergency
                            ? (labelFits(labelAbsX, labelAbsY, bubbleWidth, bubbleHeight), true)
                            : labelFits(labelAbsX, labelAbsY, bubbleWidth, bubbleHeight);

                    if (canDraw) {
                        ctx.save();
                        ctx.translate(ptX, ptY);
                        ctx.globalAlpha = labelAlpha;

                        // Shadow
                        ctx.shadowColor = isSelected ? 'rgba(34, 211, 238, 0.6)' : 'rgba(0, 0, 0, 0.6)';
                        ctx.shadowBlur = isSelected ? 10 : 5;
                        ctx.shadowOffsetY = 2;

                        // Background panel
                        ctx.fillStyle = isSelected ? 'rgba(15, 23, 42, 0.95)' : 'rgba(30, 41, 59, 0.9)';
                        ctx.beginPath();
                        ctx.moveTo(boxX + radius, boxY);
                        ctx.lineTo(boxX + bubbleWidth - radius, boxY);
                        ctx.arcTo(boxX + bubbleWidth, boxY, boxX + bubbleWidth, boxY + radius, radius);
                        ctx.lineTo(boxX + bubbleWidth, boxY + bubbleHeight - radius);
                        ctx.arcTo(boxX + bubbleWidth, boxY + bubbleHeight, boxX + bubbleWidth - radius, boxY + bubbleHeight, radius);
                        ctx.lineTo(boxX + radius, boxY + bubbleHeight);
                        ctx.arcTo(boxX, boxY + bubbleHeight, boxX, boxY + bubbleHeight - radius, radius);

                        // Pointer arrow
                        ctx.lineTo(boxX, tailHeight / 2);
                        ctx.lineTo(boxX - tailWidth, 0);
                        ctx.lineTo(boxX, -tailHeight / 2);

                        ctx.lineTo(boxX, boxY + radius);
                        ctx.arcTo(boxX, boxY, boxX + radius, boxY, radius);
                        ctx.closePath();
                        ctx.fill();

                        // Border
                        ctx.lineWidth = 1.5;
                        ctx.strokeStyle = isSelected ? '#22d3ee' : (plane.isEmergency ? '#ef4444' : 'rgba(148, 163, 184, 0.4)');
                        ctx.stroke();

                        ctx.shadowBlur = 0;
                        ctx.shadowOffsetY = 0;

                        // Content
                        let currentX = boxX + paddingX;

                        if (hasLogo) {
                            const logoBgMargin = 3;
                            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
                            ctx.beginPath();
                            if (ctx.roundRect) {
                                ctx.roundRect(currentX - logoBgMargin, boxY + (bubbleHeight - logoHeight) / 2 - logoBgMargin, logoWidth + logoBgMargin * 2, logoHeight + logoBgMargin * 2, 3);
                            } else {
                                ctx.rect(currentX - logoBgMargin, boxY + (bubbleHeight - logoHeight) / 2 - logoBgMargin, logoWidth + logoBgMargin * 2, logoHeight + logoBgMargin * 2);
                            }
                            ctx.fill();

                            ctx.drawImage(logoImg, currentX, boxY + (bubbleHeight - logoHeight) / 2, logoWidth, logoHeight);
                            currentX += logoWidth + gap / 2;

                            ctx.beginPath();
                            ctx.moveTo(currentX, boxY + 6);
                            ctx.lineTo(currentX, boxY + bubbleHeight - 6);
                            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
                            ctx.lineWidth = 1;
                            ctx.stroke();

                            currentX += gap / 2;
                        }

                        // Callsign text
                        ctx.fillStyle = isSelected ? '#ffffff' : (plane.isEmergency ? '#fca5a5' : '#e2e8f0');
                        ctx.textBaseline = 'middle';
                        ctx.fillText(labelText, currentX, 1);

                        ctx.restore();
                    } // canDraw
                    } // shouldShowLabel
                }

                if (onUsageUpdateRef.current) {
                    onUsageUpdateRef.current({ visibleCount: drawnCount, totalInView: renderQueue.length, renderLimit: maxDraw, throttleFactor: 1.0 });
                }
            }

            animFrameRef.current = requestAnimationFrame(animate);
        }

        animFrameRef.current = requestAnimationFrame(animate);
        return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
    }, []); // 永動機解耦 (Decoupled Loop Architecture)

    return (
        <div ref={mapContainerRef} className="map-container">
            {hoveredPlane && <HoverCard plane={hoveredPlane} pos={hoverPos} />}
        </div>
    );
}
