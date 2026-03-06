import React, { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { createPlaneSVG, getPlaneExtraClass, getAirlineLogoUrl, getAirportDisplayData, getGreatCirclePath, splitPathAtIDL, normalizeLongitude, predictPosition, getPlaneCanvasData } from '../utils/flightUtils';

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
}) {
    const mapContainerRef = useRef(null);
    const mapRef = useRef(null);
    const canvasLayerRef = useRef(null);
    const cachedPathsRef = useRef(new Map()); // Cache Path2D objects
    const trackLineRef = useRef(null);
    const trackLineFutureRef = useRef(null); // [v3.1] For future/predicted path during playback
    const routeLineRef = useRef(null);
    const predictiveLineRef = useRef(null);
    const animFrameRef = useRef(null);
    const lastDrawTimeRef = useRef(performance.now());
    const airportLayerRef = useRef(null);
    const airportMarkersLoadedRef = useRef(false);
    const airportMarkersMapRef = useRef(new Map());
    const tileLayerRef = useRef(null);     // [v2.9.0] current tile layer
    const speedVectorLayerRef = useRef(null); // [v2.9.0] speed vector arrows
    const trackModeRef = useRef(trackMode);  // [v3.0] ref for animation loop
    const playbackTimeRef = useRef(playbackTime); // [v3.1] ref for animation loop
    const trackPointsRef = useRef(trackPoints);   // [v3.1] ref for animation loop

    // [v3.0] Smart Tracking Interaction Refs
    const userInteractingRef = useRef(false);
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

    const [airports, setAirports] = useState([]);
    const airportsRef = useRef([]);
    const filtersRef = useRef(filters);
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
            const res = await fetch(`/api/metar?icao=${ap.icao}`);
            const data = await res.json();

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
            worldCopyJump: true // IMPORTANT: Makes markers wrap cleanly around infinite horizontal scrolls
        }).setView([25.17, 121.44], 10);

        // 加入右下角的縮放按鈕
        L.control.zoom({ position: 'bottomright' }).addTo(map);

        tileLayerRef.current = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19,
            attribution: '',
        }).addTo(map);

        speedVectorLayerRef.current = L.layerGroup().addTo(map);

        // 初始 bounds
        setBounds(map.getBounds());

        // 加入 CanvasLayer
        const cLayer = new PlaneCanvasLayer();
        map.addLayer(cLayer);
        canvasLayerRef.current = cLayer;

        // 點擊地圖偵測是否點擊到飛機
        map.on('click', (e) => {
            const clickPt = e.containerPoint;
            let closestPlane = null;
            let closestDist = 25; // 命中判定半徑

            const currentPlanes = planesDictRef.current || {};
            for (const id in currentPlanes) {
                const p = currentPlanes[id];
                if (!p.renderLat || !p.renderLng) continue;

                // 檢查是否符合過濾條件
                if (!shouldShowPlaneRef.current(p, 1.0)) continue;

                const pt = map.latLngToContainerPoint([p.renderLat, normalizeLongitude(p.renderLng)]);
                const dist = Math.hypot(pt.x - clickPt.x, pt.y - clickPt.y);
                if (dist < closestDist) {
                    closestDist = dist;
                    closestPlane = { id, plane: p };
                }
            }

            if (closestPlane) {
                L.DomEvent.stopPropagation(e.originalEvent);
                onSelectPlane(closestPlane.id, closestPlane.plane);
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
        };
        const handleInteractionEnd = () => {
            if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
            idleTimeoutRef.current = setTimeout(() => {
                userInteractingRef.current = false;
            }, 10000); // Resume tracking after 10s of inactivity
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
            setBounds(map.getBounds());
            updateAirportVisibility(map); // <--- Add this to refresh virtualized airports
            onMapMove?.();
        });

        // 機場圖層 zoom 控制
        map.on('zoomend', () => {
            updateAirportVisibility(map);
        });

        mapRef.current = map;
        onMapReady?.(map);

        // [OPT 6.2] Airport list: use sessionStorage cache to avoid redundant fetches
        const AIRPORT_CACHE_KEY = 'fr24_airports_v1';
        const AIRPORT_CACHE_TTL = 3600000; // 1 hour
        let cachedAirports = null;
        try {
            const raw = sessionStorage.getItem(AIRPORT_CACHE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Date.now() - (parsed.ts || 0) < AIRPORT_CACHE_TTL) {
                    cachedAirports = parsed.data;
                }
            }
        } catch (e) { /* ignore */ }

        if (cachedAirports) {
            console.log(`📦 [MAP] Loaded ${cachedAirports.length} airports from sessionStorage`);
            airportsRef.current = cachedAirports;
            setAirports(cachedAirports);
        } else {
            fetch('/api/airports/list')
                .then(res => res.json())
                .then(data => {
                    console.log(`🌍 [MAP] Loaded ${data.length} airports from backend`);
                    airportsRef.current = data;
                    setAirports(data);
                    try {
                        sessionStorage.setItem(AIRPORT_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
                    } catch (e) { /* storage quota exceeded, ignore */ }
                })
                .catch(err => console.error('Failed to load airports:', err));
        }

        airportLayerRef.current = L.layerGroup();
        updateAirportVisibility(map);

        return () => {
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
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

    // [v2.9.0] Speed vector arrows: 120-second prediction lines for airborne planes
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !speedVectorLayerRef.current) return;

        speedVectorLayerRef.current.clearLayers();

        const DEG_TO_RAD = Math.PI / 180;
        const R = 6371000;
        const TIME_HORIZON = 120; // seconds

        for (const id in planesDict) {
            const p = planesDict[id];
            if (p.onGround || !p.velocity || p.velocity < 10 || !p.lat || !p.lng || !p.heading) continue;

            const dist = p.velocity * TIME_HORIZON; // meters
            const headingRad = p.heading * DEG_TO_RAD;
            const latRad = p.lat * DEG_TO_RAD;

            const endLat = Math.asin(
                Math.sin(latRad) * Math.cos(dist / R) +
                Math.cos(latRad) * Math.sin(dist / R) * Math.cos(headingRad)
            ) / DEG_TO_RAD;
            const endLng = p.lng + Math.atan2(
                Math.sin(headingRad) * Math.sin(dist / R) * Math.cos(latRad),
                Math.cos(dist / R) - Math.sin(latRad) * Math.sin(endLat * DEG_TO_RAD)
            ) / DEG_TO_RAD;

            const isSelected = id === selectedIcao24;
            L.polyline([[p.lat, p.lng], [endLat, endLng]], {
                color: isSelected ? '#f59e0b' : 'rgba(255,255,255,0.25)',
                weight: isSelected ? 2 : 1,
                dashArray: isSelected ? null : '4 4',
                interactive: false,
            }).addTo(speedVectorLayerRef.current);
        }
    }, [planesDict, selectedIcao24]);



    // ===== 過濾器：判斷是否顯示飛機 (v2.3.6 Dynamic Density) =====
    const shouldShowPlane = useCallback(
        (plane, dynamicThrottle = 1.0) => {
            if (!filters.showGround && plane.onGround) return false;
            if (!filters.showEmergency && plane.isEmergency) return false;
            const alt = parseFloat(plane.altitude);
            if (!filters.showLow && !isNaN(alt) && alt < 1500) return false;

            // [v3.1] Airline Fleet Focus Mode
            if (filters.fleetFocus && (!plane.callsign || !plane.callsign.startsWith(filters.fleetFocus))) return false;

            // Local Bounds Check
            if (bounds) {
                const lat = parseFloat(plane.lat);
                const lng = parseFloat(plane.lng);
                if (lat < bounds.getSouth() || lat > bounds.getNorth() || lng < bounds.getWest() || lng > bounds.getEast()) {
                    return false;
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

    // Track Mode overrides
    useEffect(() => {
        if (selectedIcao24) {
            userInteractingRef.current = false;
            if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
        }
    }, [selectedIcao24]);

    // ===== 軌跡與航線繪製 (v2.3.3 IDL Fix) =====
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        if (trackLineRef.current) map.removeLayer(trackLineRef.current);
        if (trackLineFutureRef.current) map.removeLayer(trackLineFutureRef.current);
        if (routeLineRef.current) map.removeLayer(routeLineRef.current);
        trackLineRef.current = null;
        trackLineFutureRef.current = null;
        routeLineRef.current = null;

        if (selectedRoute && selectedRoute.depCoord && selectedRoute.arrCoord) {
            const pathPoints = getGreatCirclePath([selectedRoute.depCoord.lat, selectedRoute.depCoord.lng], [selectedRoute.arrCoord.lat, selectedRoute.arrCoord.lng]);
            const routeSegments = splitPathAtIDL(pathPoints);
            routeLineRef.current = L.polyline(routeSegments, { color: '#94a3b8', weight: 2, opacity: 0.5, dashArray: '5, 5', interactive: false }).addTo(map);
        }

        if (trackPoints && trackPoints.length > 1) {
            // [v3.1 Fix] Separate Past and Future segments if playback is active
            const pbTime = playbackTime;
            let pastPointsRaw = [];
            let futurePointsRaw = [];

            if (pbTime !== null) {
                pastPointsRaw = trackPoints.filter(p => p[0] <= pbTime);
                futurePointsRaw = trackPoints.filter(p => p[0] > pbTime);
                // Add the boundary point to both to ensure they connect
                const lastPast = pastPointsRaw[pastPointsRaw.length - 1];
                if (lastPast && futurePointsRaw[0]) futurePointsRaw.unshift(lastPast);
            } else {
                pastPointsRaw = trackPoints;
            }

            const pastCoords = pastPointsRaw.map(p => [p[1], p[2]]);
            if (pbTime === null && selectedIcao24 && planesDictRef.current[selectedIcao24]) {
                const livePlane = planesDictRef.current[selectedIcao24];
                pastCoords.push([livePlane.lat, livePlane.lng]);
            }

            const pastSegments = splitPathAtIDL(pastCoords);
            trackLineRef.current = L.polyline(pastSegments, { color: '#22d3ee', weight: 4, opacity: 1, lineCap: 'round' }).addTo(map);

            if (futurePointsRaw.length > 0) {
                const futureCoords = futurePointsRaw.map(p => [p[1], p[2]]);
                // Always add live position to the end of future segment if in playback
                if (selectedIcao24 && planesDictRef.current[selectedIcao24]) {
                    futureCoords.push([planesDictRef.current[selectedIcao24].lat, planesDictRef.current[selectedIcao24].lng]);
                }
                const futureSegments = splitPathAtIDL(futureCoords);
                trackLineFutureRef.current = L.polyline(futureSegments, {
                    color: '#22d3ee', weight: 3, opacity: 0.4, dashArray: '8, 8', lineCap: 'round'
                }).addTo(map);
            }

            if (routeLineRef.current) { map.removeLayer(routeLineRef.current); routeLineRef.current = null; }
            if (trackLineRef.current) trackLineRef.current.bringToFront();
            if (trackLineFutureRef.current) trackLineFutureRef.current.bringToBack();
        } else if (selectedIcao24 && flightHistoryRef?.current?.[selectedIcao24]) {
            const history = flightHistoryRef.current[selectedIcao24];
            if (history.length > 1) {
                const points = history.map(p => [p[1], p[2]]);
                if (planesDictRef.current[selectedIcao24]) points.push([planesDictRef.current[selectedIcao24].lat, planesDictRef.current[selectedIcao24].lng]);
                const trackSegments = splitPathAtIDL(points);
                trackLineRef.current = L.polyline(trackSegments, { color: '#f59e0b', weight: 3, opacity: 0.8, dashArray: '10, 5', lineCap: 'round' }).addTo(map);
            }
        }
        // CRITICAL BUGFIX: Removed `planesDict` from dependencies.
        // `planesDict` updates hundreds of times per second with WebSocket. 
        // We only want to rebuild the main track line when `trackPoints` or `selectedIcao24` actually changes.
    }, [trackPoints, selectedIcao24, selectedRoute, playbackTime]);

    // ===== 選中飛機時移動視角 (v2.8.0: Follow current marker position, not just API data) =====
    useEffect(() => {
        if (selectedIcao24) {
            // [v3.1] Force resume tracking on explicit selection (ignoring 10s cooldown)
            // [v3.4 Fix] Split this logic out so it only runs when `selectedIcao24` specifically changes, not on `planesDict` updates!
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

        // [v3.3] High Performance SVG Rasterization Cache
        const getSVGImage = (cData) => {
            const cacheKey = `${cData.pathData}_${cData.planeColor}_${cData.strokeColor}_${cData.strokeWidth}_${cData.scale}_${cData.size}`;
            if (!cachedPathsRef.current.has(cacheKey)) {
                const img = new Image();
                // [v3.6] High-DPI physical scaling: Rasterize at device pixel ratio, draw at physical size
                const dpr = window.devicePixelRatio || 1;
                const physicalSize = cData.size;
                const renderSize = physicalSize * dpr;

                const svgStr = `
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${renderSize}" height="${renderSize}">
                        <path fill="${cData.planeColor}" 
                              stroke="${cData.strokeColor}" 
                              stroke-width="${cData.strokeWidth}" 
                              stroke-linejoin="round"
                              d="${cData.pathData}" 
                              transform="${cData.scale !== 1.0 ? `translate(12, 12) scale(${cData.scale}) translate(-12, -12)` : ''}" />
                    </svg>
                `;
                const blob = new Blob([svgStr], { type: 'image/svg+xml' });
                const url = URL.createObjectURL(blob);
                img.src = url;
                cachedPathsRef.current.set(cacheKey, { img, drawSize: physicalSize });
            }
            return cachedPathsRef.current.get(cacheKey);
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

            // Update Positions
            Object.keys(currentPlanes).forEach(id => {
                const plane = currentPlanes[id];
                const currentLat = plane.renderLat || plane.lat;
                const currentLng = plane.renderLng || plane.lng;

                if (plane.onGround || plane.velocity <= 0 || plane.altitude === 'GROUND') {
                    if (plane.targetLat && plane.targetLng) {
                        const lerpSpeed = 0.05;
                        plane.renderLat = currentLat + (plane.targetLat - currentLat) * lerpSpeed;
                        plane.renderLng = currentLng + (plane.targetLng - currentLng) * lerpSpeed;
                    }
                } else if (plane.targetLat && plane.targetLng) {
                    const nowSec = Date.now() / 1000;
                    const anchorSec = plane.lastContact || (plane.targetUpdatedAt ? plane.targetUpdatedAt / 1000 : nowSec);
                    const elapsedSec = Math.min(nowSec - anchorSec, 120);

                    const predictedPos = predictPosition(plane.targetLat, plane.targetLng, plane.velocity, plane.heading, Math.max(0, elapsedSec));
                    const lerpFactor = 0.5;
                    plane.renderLat = currentLat + (predictedPos.lat - currentLat) * lerpFactor;
                    plane.renderLng = currentLng + (predictedPos.lng - currentLng) * lerpFactor;
                } else {
                    plane.renderLat = plane.lat;
                    plane.renderLng = plane.lng;
                }

                // 軌跡追加
                if (pbTime === null && id === currentSelected && trackLineRef.current && !plane.onGround && plane.velocity > 0) {
                    const latLngs = trackLineRef.current.getLatLngs();
                    if (latLngs.length > 0) {
                        const currentL = L.latLng(plane.renderLat, normalizeLongitude(plane.renderLng));
                        const isMulti = Array.isArray(latLngs[0]);
                        const lastSegment = isMulti ? latLngs[latLngs.length - 1] : latLngs;
                        const lastPt = lastSegment[lastSegment.length - 1];
                        if (lastPt && currentL.distanceTo(L.latLng(lastPt.lat, normalizeLongitude(lastPt.lng))) > 50) {
                            if (isMulti) {
                                const newLatLngs = [...latLngs];
                                newLatLngs[newLatLngs.length - 1] = [...lastSegment, { lat: plane.renderLat, lng: currentLng }];
                                trackLineRef.current.setLatLngs(newLatLngs);
                            } else {
                                trackLineRef.current.addLatLng({ lat: plane.renderLat, lng: currentLng });
                            }
                        }
                    }
                }
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
                const showLabels = zoom >= 6;
                const maxDraw = zoom <= 4 ? 300 : zoom <= 5 ? 800 : zoom <= 6 ? 1500 : zoom <= 7 ? 3500 : zoom <= 8 ? 6000 : 10000;
                let drawnCount = 0;

                ctx.textBaseline = 'middle';

                // Array for sorting visible planes
                const renderQueue = [];
                for (const id in currentPlanes) {
                    const plane = currentPlanes[id];
                    if (!plane.renderLat || !plane.renderLng) continue;
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

                // Render loop
                for (let i = 0; i < Math.min(maxDraw, renderQueue.length); i++) {
                    const plane = renderQueue[i];
                    const pt = map.latLngToContainerPoint([plane.renderLat, normalizeLongitude(plane.renderLng)]);

                    // Frustum culling margin (allow some margin for labels/rotation)
                    if (pt.x < -100 || pt.x > canvas.width + 100 || pt.y < -100 || pt.y > canvas.height + 100) continue;

                    drawnCount++;
                    const isSelected = plane.icao24 === currentSelected;
                    const cData = getPlaneCanvasData(plane.altitude, isSelected, plane.onGround, plane.isEmergency, plane.category, colorScheme);

                    ctx.save();
                    ctx.translate(pt.x, pt.y);

                    // Draw glow (Original aesthetic applies subtle glow to ALL planes)
                    ctx.shadowColor = cData.planeColor;
                    ctx.shadowBlur = isSelected ? 15 : (plane.onGround ? 2 : 6);

                    ctx.rotate(plane.heading * Math.PI / 180);

                    const { img, drawSize } = getSVGImage(cData);
                    if (img.complete && img.naturalHeight !== 0) {
                        const offset = drawSize / 2;
                        ctx.drawImage(img, -offset, -offset, drawSize, drawSize);
                    }

                    ctx.restore();

                    // Draw labels
                    // [v3.6] Hide unselected labels as per user request
                    if (isSelected) {
                        ctx.save();
                        ctx.translate(pt.x + 20, pt.y);

                        const logoImg = getLogoImage(plane.callsign);
                        const hasLogo = logoImg && logoImg.complete && logoImg.naturalWidth > 0;
                        const labelText = plane.callsign || plane.icao24?.slice(0, 6) || '';

                        // Fast width estimation based on char count (avoid expensive ctx.measureText)
                        const estWidth = labelText.length * 7 + (hasLogo ? 38 : 0);

                        // [v3.9 Fix] Restoring Original FR24 Speech-Bubble Aesthetic
                        const bubbleWidth = estWidth + 16;
                        const bubbleHeight = 24;
                        const radius = 4;
                        const tailWidth = 6;
                        const tailHeight = 8;
                        const yOffset = -12;
                        const boxX = tailWidth;
                        const boxY = yOffset;

                        // Draw Drop Shadow
                        ctx.shadowColor = 'rgba(0,0,0,0.3)';
                        ctx.shadowBlur = 4;
                        ctx.shadowOffsetX = 1;
                        ctx.shadowOffsetY = 1;

                        // Draw Bubble Path
                        ctx.fillStyle = '#ffffff';
                        ctx.beginPath();
                        ctx.moveTo(boxX + radius, boxY);
                        ctx.lineTo(boxX + bubbleWidth - radius, boxY);
                        ctx.arcTo(boxX + bubbleWidth, boxY, boxX + bubbleWidth, boxY + radius, radius);
                        ctx.lineTo(boxX + bubbleWidth, boxY + bubbleHeight - radius);
                        ctx.arcTo(boxX + bubbleWidth, boxY + bubbleHeight, boxX + bubbleWidth - radius, boxY + bubbleHeight, radius);
                        ctx.lineTo(boxX + radius, boxY + bubbleHeight);
                        ctx.arcTo(boxX, boxY + bubbleHeight, boxX, boxY + bubbleHeight - radius, radius);

                        // Tail pointing left to the plane center
                        ctx.lineTo(boxX, tailHeight / 2);
                        ctx.lineTo(0, 0); // The tip of the bubble tail
                        ctx.lineTo(boxX, -tailHeight / 2);

                        ctx.lineTo(boxX, boxY + radius);
                        ctx.arcTo(boxX, boxY, boxX + radius, boxY, radius);
                        ctx.closePath();
                        ctx.fill();

                        // Reset shadow for content
                        ctx.shadowColor = 'transparent';
                        ctx.shadowBlur = 0;

                        if (hasLogo) {
                            ctx.drawImage(logoImg, boxX + 8, -6, 30, 12);
                        }

                        ctx.fillStyle = '#1e293b';
                        ctx.font = 'bold 12px Inter, sans-serif';
                        ctx.fillText(labelText, boxX + (hasLogo ? 44 : 8), 4);

                        ctx.restore();
                    }
                }

                if (onUsageUpdate) {
                    onUsageUpdate({ visibleCount: drawnCount, totalInView: renderQueue.length, renderLimit: maxDraw, throttleFactor: 1.0 });
                }
            }

            animFrameRef.current = requestAnimationFrame(animate);
        }

        animFrameRef.current = requestAnimationFrame(animate);
        return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
    }, [colorScheme, onUsageUpdate]); // Persistent loop!

    return <div ref={mapContainerRef} className="map-container" />;
}
