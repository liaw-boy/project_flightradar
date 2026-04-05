import React, { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getAirlineLogoUrl, normalizeLongitude, predictPosition, getAltitudeColor, initAirportDatabase } from '../utils/flightUtils';
import { getAircraftScale, getDrawSize, resolveTypecodeKey, getDynamicImage, prewarmExactSvg, AIRCRAFT_CATALOG as paths, ICON_SCALE_VERSION } from '../utils/aircraftIcons';
import { dataManager } from '../services/dataManager';
import { enrichPlaneDetails, getEnrichedData } from '../services/staticOsintCache';
import HoverCard from './HoverCard';
import { logger } from '../utils/logger';

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
        const dpr = window.devicePixelRatio || 1;
        this._canvas.width = size.x * dpr;
        this._canvas.height = size.y * dpr;
        this._canvas.style.width = size.x + 'px';
        this._canvas.style.height = size.y + 'px';
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._reset();
    },
    _reset: function () {
        const size = this._map.getSize();
        const dpr = window.devicePixelRatio || 1;
        this._canvas.width = size.x * dpr;
        this._canvas.height = size.y * dpr;
        this._canvas.style.width = size.x + 'px';
        this._canvas.style.height = size.y + 'px';
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

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
const TRAIL_LEN = 12;    // Ring buffer depth for gradient trail (非選中飛機短尾)
const TRAIL_FPP = 2;     // Floats per trail point: [lat, lng]
const TRAIL_MIN_DIST_SQ = 0.000004; // ~2m² — skip duplicate trail points

// [v14.0] High-Performance Rendering Logic


// ─── Haversine distance helper (km) ──────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── [v14.0] Path2D Vector Object Cache (with ViewBox support) ──────────────
const vectorPathsMap = new Map();
Object.entries(paths).forEach(([key, entry]) => {
    const vbArr = (entry.vb || "0 0 500 500").split(/\s+/).map(Number);
    vectorPathsMap.set(key, {
        path: new Path2D(entry.d),
        vb: vbArr
    });
});

// ─── [PERF-4 Fix] Module-level enrichment guard — persists across React re-renders ──
const _enrichScheduled = new Set();

// ─── measureText cache — avoids redundant font measurement each frame ─────────
const _textWidthCache = new Map(); // 'font|text' → width
function measureCached(ctx, text, font) {
    const key = font + '|' + text;
    const cached = _textWidthCache.get(key);
    if (cached !== undefined) return cached;
    ctx.font = font;
    const w = ctx.measureText(text).width;
    if (_textWidthCache.size > 2000) _textWidthCache.clear();
    _textWidthCache.set(key, w);
    return w;
}

// ─── Great Circle Arc Interpolation (tar1090-style) ──────────────────────────
// For segments longer than GC_THRESHOLD_KM, insert intermediate points along
// the spherical great-circle arc so the path follows Earth's curvature.
// Returns an array of [lat, lng] tuples including the two endpoints.
const GC_THRESHOLD_KM = 500;
function greatCirclePoints(lat1, lng1, lat2, lng2, distKm) {
    const steps = Math.min(16, Math.ceil(distKm / 200)); // 1 point per ~200km, max 16
    if (steps < 2) return [[lat1, lng1], [lat2, lng2]];
    const φ1 = lat1 * Math.PI / 180, λ1 = lng1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180, λ2 = lng2 * Math.PI / 180;
    const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1);
    const sinφ2 = Math.sin(φ2), cosφ2 = Math.cos(φ2);
    const cosλd = Math.cos(λ2 - λ1);
    const d = Math.acos(Math.min(1, sinφ1 * sinφ2 + cosφ1 * cosφ2 * cosλd));
    if (d < 1e-9) return [[lat1, lng1], [lat2, lng2]];
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const A = Math.sin((1 - t) * d) / Math.sin(d);
        const B = Math.sin(t * d) / Math.sin(d);
        const x = A * cosφ1 * Math.cos(λ1) + B * cosφ2 * Math.cos(λ2);
        const y = A * cosφ1 * Math.sin(λ1) + B * cosφ2 * Math.sin(λ2);
        const z = A * sinφ1 + B * sinφ2;
        const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
        const λ = Math.atan2(y, x);
        pts.push([φ * 180 / Math.PI, (λ * 180 / Math.PI + 540) % 360 - 180]);
    }
    return pts;
}

// ─── [v12.0] Altitude Coloring Logic ─────────────────────────────────────────
// [Visual] Standardized altitude colors imported from flightUtils
// [v14.0] High-Performance Rendering Mode Active
const RENDER_MODE_FULL = 0;
const RENDER_MODE_SIMPLE = 1;

/**
 * MapView — 管理 Leaflet 地圖、飛機 markers、軌跡線、機場圖層
 * 使用原生 Leaflet（非 react-leaflet）以獲得對 marker 的完全控制
 */
// [v14.1] High-Performance Vector Silhouettes resolver
// Uses resolveTypecodeKey() from aircraftIcons for full fuzzy matching,
// guaranteeing every call returns a key that exists in vectorPathsMap.
const getAircraftVectorKey = (plane) => {
    // 1. Backend-provided shape key — only accept if it's a known catalog entry
    if (plane.icon_type) {
        const k = plane.icon_type.toUpperCase();
        if (paths[k]) return k;
    }
    // 2. Direct catalog hit (exact typecode match)
    const tc = (plane._activeTypecode || plane.typecode || '').toUpperCase();
    if (tc && paths[tc]) return tc;
    // 3. Full fuzzy resolution: prefix alias → category detection → CATEGORY_FALLBACK → DEFAULT
    //    resolveTypecodeKey() is guaranteed to return a key present in AIRCRAFT_CATALOG.
    return resolveTypecodeKey(tc, plane.category);
};

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
    mapLayer = 'dark',
    trackMode = false,
    playbackTime = null,
    t,
    translateMetar,
    syncViewport,
}) {
    const [hoveredPlane, setHoveredPlane] = useState(null);
    const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
    // Detect touch device once — skip HoverCard on mobile/tablet
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    useEffect(() => {
        // [v14.1] Data arrival sentinel for debugging - can be removed after verified
        const count = planesDict ? Object.keys(planesDict).length : 0;
        if (count > 0 && !window._hasWarnedPlanes) {
             logger.info('INIT', `Data stream active — ${count} planes in view`);
             window._hasWarnedPlanes = true;
        }
    }, [planesDict]);

    const mapContainerRef = useRef(null);
    const mapRef = useRef(null);
    const canvasLayerRef = useRef(null);
    const metadataCacheRef = useRef(new Map()); // [v3.4] Cache for logos/metadata
    const routeLineRef = useRef(null);

    const predictiveLineRef = useRef(null);
    const animFrameRef = useRef(null);
    const lastDrawTimeRef = useRef(performance.now());
    const fpsCountRef    = useRef(0);
    const fpsWindowRef   = useRef(performance.now());
    const fpsRef         = useRef(0);
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
    // [v14.5] Performance: Scale cache to avoid redundant per-frame calculations
    const scaleCacheRef = useRef(new Map());
    const idleTimeoutRef = useRef(null);
    const syncTimeoutRef = useRef(null);

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

    const [airports, setAirports] = useState([]);
    const [mapInstance, setMapInstance] = useState(null);
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

        // [PERF-1 Fix] Keyboard zoom (+/-) also needs simplified render mode during animation
        const handleKeyZoom = (e) => {
            if (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '_') {
                handleInteractionStart();
                setTimeout(handleInteractionEnd, 400);
            }
        };
        container.addEventListener('keydown', handleKeyZoom);

        // Also listen to drag end specifically from leaflet
        map.on('dragend', handleInteractionEnd);

        // 地圖移動結束
        map.on('moveend', () => {
            const currentBounds = map.getBounds();
            setBounds(currentBounds);
            updateAirportVisibility(map);
            onMapMove?.();

            // [Project AERO-SYNC] Viewport-Driven Sync (Debounced to avoid 429)
            if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
            syncTimeoutRef.current = setTimeout(() => {
                syncViewport?.({
                    lamin: currentBounds.getSouth(),
                    lomin: currentBounds.getWest(),
                    lamax: currentBounds.getNorth(),
                    lomax: currentBounds.getEast()
                });
            }, 1000);
        });

        // [AERO-SYNC] 僅在縮放結束時更新全局投影快取
        map.on('zoomend', () => {
            updateAllProjectionCaches(map);
            updateAirportVisibility(map);

            const currentBounds = map.getBounds();
            if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
            syncTimeoutRef.current = setTimeout(() => {
                syncViewport?.({
                    lamin: currentBounds.getSouth(),
                    lomin: currentBounds.getWest(),
                    lamax: currentBounds.getNorth(),
                    lomax: currentBounds.getEast()
                });
            }, 1000);
        });

        // [AERO-SYNC] 動態懸停游標 (Dynamic Hover Pointer) — 觸控裝置跳過
        map.on('mousemove', (e) => {
            if (isTouchDevice) return;
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
                // 夾持座標，避免 HoverCard (240px × ~180px) 超出視口邊緣
                const CARD_W = 240, CARD_H = 180;
                const vw = window.innerWidth, vh = window.innerHeight;
                const cx = Math.min(mousePt.x, vw - CARD_W / 2 - 8);
                const cy = mousePt.y < CARD_H + 16 ? mousePt.y + CARD_H / 2 + 16 : mousePt.y;
                setHoverPos({ x: cx, y: cy });
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
        setMapInstance(map);

        // [Project AERO-SYNC] L3 Persistent Airport Loading
        dataManager.getAirports().then(data => {
            logger.info('INIT', `Loaded ${data.length} airports from DataManager`);
            airportsRef.current = data;
            setAirports(data);
            initAirportDatabase(data);
        }).catch(err => logger.error('INIT', `Failed to load airports: ${err.message}`));

        airportLayerRef.current = L.layerGroup();
        updateAirportVisibility(map);

        return () => {
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
            container.removeEventListener('keydown', handleKeyZoom);
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
            if (visible && ap && ap.lat != null && ap.lng != null && extBounds.contains([ap.lat, ap.lng])) {
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
            if (!ap || ap.lat == null || ap.lng == null) continue;

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

            // Aircraft category filters (PlaneFinder-style)
            // category 8 = Rotorcraft/Helicopter
            if (filters.showHelicopter === false && plane.category === 8) return false;
            // category 14 = UAV / Drone
            if (filters.showDrone === false && plane.category === 14) return false;
            // category 2 = Light aircraft (< 15,500 lbs)
            if (filters.showLight === false && plane.category === 2) return false;
            // Military: category 7 (high-performance) + known military typecode prefixes
            if (filters.showMilitary === false) {
                if (plane.category === 7) return false;
                const tc = (plane.typecode || '').toUpperCase();
                if (/^(F1[56789]|F2[012]|B52|B1|B2|C130|C17|C5|KC|A10|U2|SR71|MIG|SU2|SU3|JA3|JAS|EF2|TYFN)/.test(tc)) return false;
            }

            // [v9.8] Redundant spatial culling removed (now handled in animate() loop for 60fps)

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
        const isMobile = window.innerWidth <= 768;

        // 手機：不強制改 zoom，只 pan；桌面：zoom 至少 10
        const targetZoom = isMobile ? map.getZoom() : Math.max(map.getZoom(), 10);

        // 飛機已在視野中心附近 → 跳過，避免無意義跳動
        if (map.getCenter().distanceTo(targetLatLng) < 5 && map.getZoom() === targetZoom) {
            return;
        }

        if (isMobile) {
            // 手機底部 compact card 約 100px，只需輕微向上偏移讓飛機不被卡片遮住
            const cardH = 110;
            const offsetPx = cardH / 2;
            const pt = map.project(targetLatLng, targetZoom);
            const adjustedLatLng = map.unproject(L.point(pt.x, pt.y + offsetPx), targetZoom);
            map.panTo(adjustedLatLng, { animate: true, duration: 0.4, easeLinearity: 0.5 });
        } else {
            map.setView(targetLatLng, targetZoom, { animate: true });
        }
    }, [selectedIcao24, planesDict]);

    // ===== 動畫引擎與 Canvas 渲染 (Project AERO-SYNC) =====
    useEffect(() => {
        const map = mapInstance;
        if (!map) return;


        // [v3.4] Airline Logo Cache for Canvas
        const getLogoImage = (callsign) => {
            const logoUrl = getAirlineLogoUrl(callsign);
            if (!logoUrl) return null;
            if (!metadataCacheRef.current.has(logoUrl)) {
                const img = new Image();
                img.src = logoUrl;
                metadataCacheRef.current.set(logoUrl, img);
            }
            return metadataCacheRef.current.get(logoUrl);
        };

        function animate(time) {
            const currentPlanes = planesDictRef.current || {};
            const currentPlanesKeys = Object.keys(currentPlanes);
            const currentSelected = selectedIcao24Ref.current;
            const pbTime = playbackTimeRef.current;
            let isPlaybackActive = false;

            // Calculate a safe delta-time for animations, capped at 100ms
            // to prevent "teleportation" after switching tabs
            const nowMs = performance.now();
            const rawDt = nowMs - lastDrawTimeRef.current;
            const dt = Math.min(rawDt, 100) / 1000; // in seconds
            lastDrawTimeRef.current = nowMs;

            // [PERF-3 Fix] Single unified loop: Interpolation + Trail Recording + Enrichment
            // Merges two separate Object.keys() iterations into one pass per frame.
            Object.keys(currentPlanes).forEach(id => {
                const plane = currentPlanes[id];

                // [PERF-4 Fix] Enrichment check using module-level Set — survives setState spreads.
                // Never triggers duplicate requests even when plane objects are replaced by WS updates.
                const enriched = getEnrichedData(id);
                const activeTypecode = plane.typecode || (enriched ? enriched.typecode : null);
                if (!activeTypecode && !_enrichScheduled.has(id)) {
                    if (_enrichScheduled.size > 5000) _enrichScheduled.clear();
                    _enrichScheduled.add(id);
                    enrichPlaneDetails(id).catch(() => {});
                }
                plane._activeTypecode = activeTypecode;

                // Pre-warm exact SVG once per typecode — no-op on repeat calls.
                if (activeTypecode && !plane._svgPrewarmed) {
                    plane._svgPrewarmed = true;
                    prewarmExactSvg(activeTypecode);
                }

                // === Interpolation (Phase 8) ===
                const currentLat = plane.renderLat || plane.lat;
                const currentLng = plane.renderLng || plane.lng;
                const lerpFactor = 0.15;

                if (plane.onGround || plane.velocity <= 0 || plane.altitude === 'GROUND') {
                    if (plane.targetLat && plane.targetLng) {
                        plane.renderLat = currentLat + (plane.targetLat - currentLat) * lerpFactor;
                        plane.renderLng = currentLng + (plane.targetLng - currentLng) * lerpFactor;
                    }
                } else if (plane.targetLat && plane.targetLng) {
                    // [Fix] Use wall-clock elapsed time instead of accumulated simTime.
                    const anchorMs = plane.targetUpdatedAt || ((plane.lastContact || 0) * 1000) || Date.now();
                    const elapsedSec = Math.min(Math.max(0, (Date.now() - anchorMs) / 1000), 30);
                    const predictedPos = predictPosition(plane.targetLat, plane.targetLng, plane.velocity, plane.heading, elapsedSec);

                    const rawLat = currentLat + (predictedPos.lat - currentLat) * lerpFactor;
                    const rawLng = currentLng + (predictedPos.lng - currentLng) * lerpFactor;

                    // [Phase 3] Clamp max per-frame movement to prevent icon teleporting on sharp turns.
                    // Cap at 2 poll-cycles worth of flight distance (2 × 25s × speed).
                    const maxDeg = ((plane.velocity || 0) * 50) / 111_000;
                    const dLat = rawLat - currentLat;
                    const dLng = rawLng - currentLng;
                    const distDeg = Math.sqrt(dLat * dLat + dLng * dLng);
                    if (maxDeg > 0 && distDeg > maxDeg) {
                        const scale = maxDeg / distDeg;
                        plane.renderLat = currentLat + dLat * scale;
                        plane.renderLng = currentLng + dLng * scale;
                    } else {
                        plane.renderLat = rawLat;
                        plane.renderLng = rawLng;
                    }
                } else {
                    plane.renderLat = plane.lat;
                    plane.renderLng = plane.lng;
                }

                // === Trail Ring Buffer Recording ===
                const lat = plane.renderLat;
                const lng = plane.renderLng;
                if (!lat || !lng) return;

                if (!plane._trail) {
                    plane._trail = new Float64Array(TRAIL_LEN * TRAIL_FPP);
                    plane._trailHead = 0;
                    plane._trailCount = 0;
                    plane._trail[0] = lat;
                    plane._trail[1] = lng;
                    plane._trailCount = 1;
                    return;
                }

                const prevIdx = ((plane._trailHead + TRAIL_LEN - 1) % TRAIL_LEN) * TRAIL_FPP;
                const dLat = lat - plane._trail[prevIdx];
                const dLng = lng - plane._trail[prevIdx + 1];
                if (dLat * dLat + dLng * dLng < TRAIL_MIN_DIST_SQ) return;

                const writeIdx = plane._trailHead * TRAIL_FPP;
                plane._trail[writeIdx]     = lat;
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
                // Use CSS-pixel dimensions (map.getSize) so clearRect/culling/grid are
                // DPR-invariant — canvas.width/height are physical pixels but all
                // coordinate math (ptX/ptY, labels) lives in CSS-pixel space.
                const mapSize = map.getSize();
                const canvasCssW = mapSize.x;
                const canvasCssH = mapSize.y;
                ctx.clearRect(0, 0, canvasCssW, canvasCssH);

                // [v9.0] Safety Guard: Ensure map is fully initialized before zoom lookup
                if (!map || typeof map.getZoom !== 'function') return;
                const zoom = map.getZoom();

                // ── [v15.0] Trajectory Path Pre-Processing ──────────
                // Pre-calculate the trajectory for the selected plane once per frame. 
                // This is shared by both the track-drawing and aircraft-heading loops.
                const flightPath = trackPointsRef.current;
                let activeSelectedPath = null;
                const livePlane = currentSelected ? currentPlanes[currentSelected] : null;

                if (flightPath && flightPath.length > 1 && livePlane) {
                    const liveTime = livePlane?.lastContact || 0;
                    const trimmedPath = (liveTime > 0)
                        ? flightPath.filter(pt => !pt[0] || pt[0] <= liveTime + 10) // 10s tolerance
                        : flightPath;
                    const basePath = trimmedPath.length > 1 ? trimmedPath : flightPath;

                    // [Phase 2] Dead-reckoning track extension:
                    // Use renderLat/renderLng (current predicted position = where icon is drawn)
                    // as the live stitch point, with wall-clock "now" as the timestamp.
                    // This keeps the track endpoint pixel-perfect aligned with the icon at all
                    // times — no gap, no backward snap when new ADS-B data arrives.
                    const livePathLat = livePlane?.renderLat ?? livePlane?.lat;
                    const livePathLng = livePlane?.renderLng ?? livePlane?.lng;
                    activeSelectedPath = (livePathLat && livePathLng)
                        ? [...basePath, [
                            Date.now() / 1000,
                            livePathLat,
                            livePathLng,
                            livePlane.altitude,
                            livePlane.heading,
                            livePlane.velocity
                          ]]
                        : basePath;
                }

                // ── [v8.0] Professional Altitude-Colored Track with Outline ──
                if (activeSelectedPath && activeSelectedPath.length > 1) {
                    ctx.save();
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';

                    // ── Pre-project all points and tag each segment ──────────
                    // Build a segments array: { pt, seg, stale, gap, isLive }
                    // stale  = time gap 60–1800s  → dashed line
                    // gap    = time gap >1800s or dist >50km → break line
                    // isLive = the live-stitch segment (last point = current interpolated pos)
                    //          → drawn as elastic band (thinner, lighter)
                    // Long segments (>GC_THRESHOLD_KM) are expanded to great circle arcs.
                    const segments = [];
                    for (let pi = 0; pi < activeSelectedPath.length; pi++) {
                        const seg = activeSelectedPath[pi];
                        const isLastPoint = pi === activeSelectedPath.length - 1;
                        const isLive = isLastPoint && (livePlane?.lat || livePlane?.renderLat);
                        const pt = map.latLngToContainerPoint([seg[1], normalizeLongitude(seg[2])]);
                        let stale = false;
                        let gap   = false;

                        if (pi > 0) {
                            const prevSeg = activeSelectedPath[pi - 1];
                            const timeDeltaSec = seg[0] && prevSeg[0] ? seg[0] - prevSeg[0] : 0;
                            const dist = haversineKm(prevSeg[1], prevSeg[2], seg[1], seg[2]);
                            const isAntimeridian = Math.abs(pt.x - (segments[segments.length - 1]?.pt.x ?? pt.x)) > canvasCssW / 2;

                            if (isAntimeridian || (dist > 50 && !isLive) || timeDeltaSec > 1800) {
                                gap = true;
                            } else if (timeDeltaSec > 60 && !isLive) {
                                stale = true;
                            }

                            // Great circle arc expansion for long non-gap segments
                            if (!gap && dist > GC_THRESHOLD_KM) {
                                const gcPts = greatCirclePoints(prevSeg[1], prevSeg[2], seg[1], seg[2], dist);
                                // Insert intermediate points (skip first — already in segments, skip last — will be added below)
                                for (let gi = 1; gi < gcPts.length - 1; gi++) {
                                    const [gLat, gLng] = gcPts[gi];
                                    const gPt = map.latLngToContainerPoint([gLat, normalizeLongitude(gLng)]);
                                    // Interpolate altitude linearly for intermediate points
                                    const t = gi / (gcPts.length - 1);
                                    const iAlt = (prevSeg[3] || 0) + t * ((seg[3] || 0) - (prevSeg[3] || 0));
                                    segments.push({ pt: gPt, seg: [null, gLat, gLng, iAlt, seg[4], seg[5]], stale, gap: false, isLive: false });
                                }
                            }
                        }

                        segments.push({ pt, seg, stale, gap, isLive });
                    }

                    // ── Quadratic Bezier smooth path renderer ───────────────
                    const drawSmoothedPath = (pts, isOutline, altColor, isDashed, isLiveSeg) => {
                        if (pts.length < 2) return;
                        ctx.beginPath();
                        if (isLiveSeg) {
                            // Live-stitch segment: now safe to draw because livePathLat/Lng = renderLat/Lng
                            // (the icon position). No more backward snap. Draw as thin solid line.
                            ctx.setLineDash([]);
                            ctx.globalAlpha = isOutline ? 0.4 : 0.65;
                            if (!isOutline) ctx.strokeStyle = altColor;
                        } else if (isDashed) {
                            ctx.setLineDash([8, 12]);
                            ctx.globalAlpha = isOutline ? 0.5 : 0.7;
                            if (!isOutline) ctx.strokeStyle = altColor;
                        } else {
                            ctx.setLineDash([]);
                            ctx.globalAlpha = isOutline ? 0.8 : 1.0;
                            if (!isOutline) ctx.strokeStyle = altColor;
                        }
                        ctx.moveTo(pts[0].x, pts[0].y);
                        if (pts.length === 2) {
                            ctx.lineTo(pts[1].x, pts[1].y);
                        } else {
                            for (let k = 1; k < pts.length - 1; k++) {
                                const midX = (pts[k].x + pts[k + 1].x) / 2;
                                const midY = (pts[k].y + pts[k + 1].y) / 2;
                                ctx.quadraticCurveTo(pts[k].x, pts[k].y, midX, midY);
                            }
                            ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
                        }
                        ctx.stroke();
                        ctx.setLineDash([]);
                    };

                    const drawTrack = (isOutline) => {
                        const baseWidth = zoom >= 12 ? 2.5 : 2;
                        ctx.lineWidth = isOutline ? baseWidth * 2 : baseWidth;
                        ctx.strokeStyle = isOutline ? 'rgba(0,0,0,0.8)' : '#ffffff';

                        let batch = [];
                        let batchColor = null;
                        let batchStale = false;
                        let batchIsLive = false;

                        const flushBatch = () => {
                            if (batch.length > 1) drawSmoothedPath(batch, isOutline, batchColor, batchStale, batchIsLive);
                            batch = [];
                            batchColor = null;
                            batchStale = false;
                            batchIsLive = false;
                        };

                        for (let pi = 0; pi < segments.length; pi++) {
                            const { pt, seg, stale, gap, isLive } = segments[pi];

                            if (gap) {
                                flushBatch();
                                batch = [pt];
                                continue;
                            }

                            const altColor = isOutline ? null : getAltitudeColor(seg[3], false, false, 'ALTITUDE');

                            // Flush when color, stale, or live status changes
                            if (batchColor !== null && (!isOutline && (altColor !== batchColor || stale !== batchStale || isLive !== batchIsLive))) {
                                flushBatch();
                            }

                            if (batch.length === 0 && pi > 0 && !segments[pi - 1].gap) {
                                batch.push(segments[pi - 1].pt);
                            }

                            batch.push(pt);
                            batchColor = altColor;
                            batchStale = stale;
                            batchIsLive = isLive;
                        }
                        flushBatch();
                    };

                    // Two passes for crisp layering
                    drawTrack(true);  // Black outline pass
                    drawTrack(false); // Altitude-gradient colored pass

                    ctx.restore();
                }

                // ── Live-Tail 短尾已移除 ──
                // 選中飛機的路徑由「歷史軌跡 + Live Stitch 虛線」完整覆蓋：
                //   - 歷史軌跡（高度梯度色）負責 DB 有記錄的部分
                //   - Live Stitch 虛線彈性段（lines 996-1005）負責最後一個 DB 點到當前位置
                // 短尾移除後消除了接縫不符的根本來源，視覺上無損失。

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
                const shouldShow = shouldShowPlaneRef.current;

                for (const id in currentPlanes) {
                    const plane = currentPlanes[id];
                    const pLat = plane.renderLat || plane.lat;
                    const pLng = plane.renderLng || plane.lng;

                    // Frustum Culling
                    if (pLat < cullS || pLat > cullN || pLng < cullW || pLng > cullE) continue;
                    if (shouldShow && !shouldShow(plane, 1.0)) continue;

                    renderQueue.push(plane);
                }

                // ── Label Collision Grid ──────────────────────────────────
                // Spatial hash for O(1) label overlap detection.
                // Grid cell = 60×30 px — slightly larger than a typical label bubble.
                const CELL_W = 60;
                const CELL_H = 30;
                const gridCols = Math.ceil(canvasCssW / CELL_W) + 1;
                const gridRows = Math.ceil(canvasCssH / CELL_H) + 1;
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

                    const rLat = plane.renderLat || plane.lat || plane.latitude;
                    const rLng = plane.renderLng || plane.lng || plane.longitude;

                    const pt = map.latLngToContainerPoint([rLat, normalizeLongitude(rLng)]);
                    const ptX = pt.x;
                    const ptY = pt.y;

                    // Frustum culling
                    if (ptX < -100 || ptX > canvasCssW + 100 || ptY < -100 || ptY > canvasCssH + 100) continue;

                    drawnCount++;
                    const isSelected = plane.icao24 === currentSelected;

                    // Data age → opacity
                    const dataAge = (nowMs / 1000) - (plane.lastContact || (nowMs / 1000));
                    let opacity = 1.0;
                    if (dataAge > 60) opacity = 0.4;
                    else if (dataAge > 30) opacity = 0.7;

                    // [Phase 15] Focus Mode Dimming
                    if (currentSelected && !isSelected) {
                        opacity = 0.3;
                    }

                    // [v12.9] Short altitude-colored trail for non-selected aircraft
                    // Selected aircraft gets full historical track above; non-selected get
                    // a short fading tail from the ring buffer to show recent movement.
                    if (!isSelected && plane._trail && plane._trailCount >= 2 && zoom >= 5) {
                        const count = plane._trailCount;
                        const head  = plane._trailHead;
                        const trailAltColor = getAltitudeColor(plane.altitude, plane.onGround, false, 'ALTITUDE');
                        ctx.save();
                        ctx.lineCap = 'round';
                        ctx.lineJoin = 'round';
                        ctx.lineWidth = 1.5;

                        for (let j = 1; j < count; j++) {
                            const idxA = ((head - count + j - 1 + TRAIL_LEN) % TRAIL_LEN) * TRAIL_FPP;
                            const idxB = ((head - count + j     + TRAIL_LEN) % TRAIL_LEN) * TRAIL_FPP;
                            const pA = map.latLngToContainerPoint([plane._trail[idxA], normalizeLongitude(plane._trail[idxA + 1])]);
                            const pB = map.latLngToContainerPoint([plane._trail[idxB], normalizeLongitude(plane._trail[idxB + 1])]);
                            const segAlpha = (j / count) * (currentSelected ? 0.15 : 0.45);
                            ctx.globalAlpha = segAlpha;
                            ctx.strokeStyle = trailAltColor;
                            ctx.beginPath();
                            ctx.moveTo(pA.x, pA.y);
                            ctx.lineTo(pB.x, pB.y);
                            ctx.stroke();
                        }
                        ctx.restore();
                    }

                    // [v12.9] Pulsing glow ring for selected aircraft
                    if (isSelected) {
                        const pulse = (nowMs % 2000) / 2000;
                        const ringR = 14 + pulse * 22;
                        const ringAlpha = (1 - pulse) * 0.55;
                        ctx.save();
                        ctx.globalAlpha = ringAlpha;
                        ctx.strokeStyle = '#22d3ee';
                        ctx.lineWidth = 1.5;
                        ctx.beginPath();
                        ctx.arc(ptX, ptY, ringR, 0, Math.PI * 2);
                        ctx.stroke();
                        // Inner static glow
                        ctx.globalAlpha = 0.25;
                        ctx.strokeStyle = '#22d3ee';
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.arc(ptX, ptY, 10, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.restore();
                    }

                    // [v14.0] High-Performance Canvas Vector Rendering (tar1090 style)
                    // Eliminates external image loading latency and improves visual density.
                    // [v14.5] Performance Optimization: Cache final drawSize by zoom
                    const activeTypecode = plane._activeTypecode || plane.typecode || 'STANDARD_JET';
                    const cacheKey = `${activeTypecode}_${zoom}_v${ICON_SCALE_VERSION}`;
                    let drawSize = scaleCacheRef.current.get(cacheKey);

                    if (drawSize === undefined) {
                        const wingspanScale = getAircraftScale(plane);
                        drawSize = getDrawSize(plane, zoom, wingspanScale);
                        scaleCacheRef.current.set(cacheKey, drawSize);
                        
                        // Prune cache if too large (LRU-ish)
                        if (scaleCacheRef.current.size > 1000) {
                             const firstKey = scaleCacheRef.current.keys().next().value;
                             scaleCacheRef.current.delete(firstKey);
                        }
                    }
                    const altColor = getAltitudeColor(plane.altitude, plane.onGround, plane.isEmergency, colorSchemeRef.current);
                    const rawHeading = plane.heading || 0;
                    let angleRad = rawHeading * Math.PI / 180;

                    // [v15.1] Trajectory-Aligned Heading Synchronization (Hardened)
                    // Only use path-derived angle when ADS-B heading is unavailable (rawHeading === 0).
                    // Using pathAngle to OVERRIDE a valid ADS-B heading caused 180° flips when
                    // the last two track points lagged behind the actual turn direction.
                    if (isSelected && rawHeading === 0 && activeSelectedPath && activeSelectedPath.length >= 2) {
                        const lastPt = activeSelectedPath[activeSelectedPath.length - 1];
                        const prevPt = activeSelectedPath[activeSelectedPath.length - 2];

                        if (lastPt && prevPt) {
                            // Support both [ts, lat, lng] and {lat, lng} formats
                            const getVal = (p, idx, key) => (Array.isArray(p) ? p[idx] : p[key]);
                            const lat0 = getVal(prevPt, 1, 'lat');
                            const lng0 = getVal(prevPt, 2, 'lng');
                            const lat1 = getVal(lastPt, 1, 'lat');
                            const lng1 = getVal(lastPt, 2, 'lng');

                            if (lat0 !== undefined && lat1 !== undefined) {
                                const dy = lat1 - lat0;
                                const dx = (lng1 - lng0) * Math.cos(lat1 * Math.PI / 180);
                                const pathAngle = Math.atan2(dx, dy);

                                // SAFETY: Only apply if pathAngle is a valid number and dx/dy aren't zero
                                if (Number.isFinite(pathAngle) && (dx !== 0 || dy !== 0)) {
                                    angleRad = pathAngle;
                                }
                            }
                        }
                    }

                    // ── 3-Tier Render Pipeline ────────────────────────────────
                    // Tier 1: Safety dot    — only if drawSize ≤ 3 (should never happen with new minimums)
                    // Tier 2: GitHub SVG    — exact 1:1 shape (async pre-warmed)
                    // Tier 3: Path2D embed  — instant, always available fallback

                    if (drawSize <= 3) {
                        // ── Tier 1: Tactical Dot ─────────────────────────────
                        const dotR = Math.max(2, drawSize / 2);
                        ctx.save();
                        ctx.globalAlpha = opacity;
                        // Dark border for contrast
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.beginPath();
                        ctx.arc(ptX, ptY, dotR + 1.2, 0, Math.PI * 2);
                        ctx.fill();
                        // Colored center
                        ctx.fillStyle = isSelected ? '#00ffff' : altColor;
                        ctx.beginPath();
                        ctx.arc(ptX, ptY, dotR, 0, Math.PI * 2);
                        ctx.fill();
                        if (isSelected) {
                            ctx.strokeStyle = '#00ffff';
                            ctx.lineWidth = 1.5;
                            ctx.stroke();
                        }
                        ctx.restore();
                    } else {
                        const dynImg = getDynamicImage(activeTypecode, isSelected);
                        if (dynImg && dynImg.complete) {
                            // ── Tier 2: 1:1 Exact SVG (pre-warmed, has built-in white outline)
                            ctx.save();
                            ctx.globalAlpha = opacity;
                            ctx.translate(ptX, ptY);
                            ctx.rotate(angleRad);
                            ctx.drawImage(dynImg, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
                            ctx.restore();
                        } else {
                            // ── Tier 3: Embedded Path2D Silhouette ───────────
                            const vectorKey = getAircraftVectorKey(plane);
                            const vectorData = vectorPathsMap.get(vectorKey);

                            if (vectorData) {
                                const { path, vb } = vectorData;
                                const vbW = vb[2], vbH = vb[3];
                                const maxDim = Math.max(vbW, vbH) || 1;
                                const canvasScale = drawSize / maxDim;
                                ctx.save();
                                ctx.globalAlpha = opacity;
                                ctx.translate(ptX, ptY);
                                ctx.rotate(angleRad);
                                ctx.scale(canvasScale, canvasScale);
                                ctx.translate(-(vb[0] + vbW / 2), -(vb[1] + vbH / 2));
                                ctx.lineJoin = 'round';
                                // Pass 1: dark shadow outline (3px normalized)
                                ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                                ctx.lineWidth = Math.max(1.0, 3.5 / canvasScale);
                                ctx.stroke(path);
                                // Pass 2: colored fill
                                ctx.fillStyle = altColor;
                                ctx.fill(path);
                                // Pass 3: thin white outline (1.2px normalized)
                                ctx.strokeStyle = isSelected ? '#00ffff' : 'rgba(255,255,255,0.95)';
                                ctx.lineWidth = isSelected ? Math.max(1.0, 2.5 / canvasScale) : Math.max(0.4, 1.2 / canvasScale);
                                ctx.stroke(path);
                                ctx.restore();
                            } else {
                                // ── Tier 4: Safety fallback dot (resolveTypecodeKey should prevent this) ──
                                ctx.save();
                                ctx.globalAlpha = opacity;
                                ctx.fillStyle = altColor;
                                ctx.beginPath();
                                ctx.arc(ptX, ptY, 5, 0, Math.PI * 2);
                                ctx.fill();
                                ctx.restore();
                            }
                        }
                    }

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

                        const _labelFont = 'bold 13px "JetBrains Mono", "Roboto Mono", Inter, sans-serif';
                        const textWidth = measureCached(ctx, labelText, _labelFont);
                        ctx.font = _labelFont;

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

                // FPS counter (1-second sliding window)
                fpsCountRef.current++;
                const fpsNow = performance.now();
                if (fpsNow - fpsWindowRef.current >= 1000) {
                    fpsRef.current = fpsCountRef.current;
                    fpsCountRef.current = 0;
                    fpsWindowRef.current = fpsNow;
                }

                if (onUsageUpdateRef.current) {
                    onUsageUpdateRef.current({
                        visibleCount: drawnCount,
                        totalInView: renderQueue.length,
                        renderLimit: maxDraw,
                        throttleFactor: 1.0,
                        fps: fpsRef.current,
                    });
                }
            }

            animFrameRef.current = requestAnimationFrame(animate);
        }

        animFrameRef.current = requestAnimationFrame(animate);
        return () => {
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        };
    }, [mapInstance]); // Starts ONLY when map is ready. Size (1) is stable after first mount.

    return (
        <div ref={mapContainerRef} className="map-container">
            {hoveredPlane && <HoverCard plane={hoveredPlane} pos={hoverPos} />}
            <AltitudeLegend colorScheme={colorScheme} />
        </div>
    );
}

// ─── Altitude Color Legend ──────────────────────────────────────────────────
// Shows the tar1090 HSL gradient with altitude labels, matching the track colors.
// Only visible in ALTITUDE scheme; hidden in TACTICAL and other solid-color modes.
function AltitudeLegend({ colorScheme }) {
    if (colorScheme === 'TACTICAL' || colorScheme === 'MONO') return null;

    // Key stops from the tar1090 HSL table (label, hue, sat, light)
    const stops = [
        { label: 'GND',    h: 20,  s: 88, l: 52 },
        { label: '3km',    h: 140, s: 88, l: 41 },
        { label: '12km',   h: 300, s: 88, l: 48 },
        { label: '15km+',  h: 360, s: 88, l: 52 },
    ];
    const gradientColors = [
        `hsl(20,88%,52%)`,
        `hsl(54,88%,49%)`,
        `hsl(140,88%,41%)`,
        `hsl(220,88%,52%)`,
        `hsl(300,88%,48%)`,
        `hsl(360,88%,52%)`,
    ].join(', ');

    return (
        <div style={{
            position: 'absolute',
            bottom: '28px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '3px',
            pointerEvents: 'none',
        }}>
            <div style={{
                width: '220px',
                height: '7px',
                borderRadius: '4px',
                background: `linear-gradient(to right, ${gradientColors})`,
                boxShadow: '0 1px 6px rgba(0,0,0,0.7)',
            }} />
            <div style={{
                width: '220px',
                display: 'flex',
                justifyContent: 'space-between',
                padding: '0 2px',
            }}>
                {stops.map(({ label, h, s, l }) => (
                    <span key={label} style={{
                        fontSize: '9px',
                        fontFamily: 'JetBrains Mono, monospace',
                        fontWeight: 700,
                        color: `hsl(${h},${s}%,${Math.min(l + 15, 80)}%)`,
                        textShadow: '0 1px 3px rgba(0,0,0,0.9)',
                        letterSpacing: '0.4px',
                    }}>{label}</span>
                ))}
            </div>
        </div>
    );
}
