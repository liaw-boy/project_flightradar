import React, { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { createPlaneSVG, getPlaneExtraClass, getAirlineLogoUrl, getAirportDisplayData, getGreatCirclePath, splitPathAtIDL, normalizeLongitude } from '../utils/flightUtils';

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
    selectedRoute, // ADDED PROPS
    onSelectPlane,
    onDeselectPlane,
    onMapReady,
    onMapMove,
    onUsageUpdate, // ADDED: 用於回報資源使用狀況
    colorScheme = 'TACTICAL', // [v2.6.7] NEW PROP
    t,
    translateMetar,
}) {
    const mapContainerRef = useRef(null);
    const mapRef = useRef(null);
    const markersRef = useRef({});
    const trackLineRef = useRef(null);
    const routeLineRef = useRef(null); // [v2.3.3] Theoretical Route Path
    const predictiveLineRef = useRef(null);
    const animFrameRef = useRef(null);
    const lastDrawTimeRef = useRef(performance.now());
    const airportLayerRef = useRef(null);
    const airportMarkersLoadedRef = useRef(false);

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

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19,
            attribution: '',
        }).addTo(map);

        // 初始 bounds
        setBounds(map.getBounds());

        // 點擊地圖空白處取消選擇
        map.on('click', () => onDeselectPlane());

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

        // 初始載入機場列表 (From Backend)
        fetch('/api/airports/list')
            .then(res => res.json())
            .then(data => {
                console.log(`🌍 [MAP] Loaded ${data.length} airports from backend`);
                airportsRef.current = data;
                setAirports(data);
            })
            .catch(err => console.error('Failed to load airports:', err));

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

    // ===== 機場顯隱與虛擬化渲染 (Virtualized Rendering) =====
    function updateAirportVisibility(map) {
        if (!map || !airportLayerRef.current) return;
        const zoom = map.getZoom();
        const bounds = map.getBounds();

        const currentAirports = airportsRef.current || [];
        const currentFilters = filtersRef.current || {};

        // [v2.3.5] 分級門檻邏輯 (調整後)
        // Zoom < 7: 全部隱藏
        // Zoom 7: 僅顯示 Tier 1 (Hubs)
        // Zoom 8: 顯示 Tier 1 + Tier 2 (Major: 有 IATA)
        // Zoom 9+: 顯示所有
        const showTier1 = zoom >= 7;
        const showTier2 = zoom >= 8;
        const showTier3 = zoom >= 9;

        if (showTier1 && currentFilters.showAirports) {
            if (!map.hasLayer(airportLayerRef.current)) {
                map.addLayer(airportLayerRef.current);
            }

            airportLayerRef.current.clearLayers();
            const extBounds = bounds.pad(0.3);

            for (let i = 0; i < currentAirports.length; i++) {
                const ap = currentAirports[i];

                // 判斷機場等級
                const isTier1 = TIER1_AIRPORTS.includes(ap.icao);
                const isTier2 = ap.iata && ap.iata.length === 3;
                const isTier3 = !isTier2;

                let visible = false;
                if (isTier1) visible = showTier1;
                else if (isTier2) visible = showTier2;
                else if (isTier3) visible = showTier3;

                if (visible && extBounds.contains([ap.lat, ap.lng])) {
                    const m = L.marker([ap.lat, ap.lng], {
                        icon: createAirportIcon(isTier1 ? 'large' : isTier2 ? 'medium' : 'small'),
                        interactive: true,
                        zIndexOffset: isTier1 ? 100 : isTier2 ? 50 : 0,
                    });

                    const labelName = ap.city && ap.city !== ap.name.toUpperCase() ? `${ap.name} (${ap.city})` : ap.name;
                    m.bindTooltip(`${ap.icao} - ${labelName}`, {
                        permanent: false,
                        direction: 'right',
                        offset: [10, 0],
                        className: 'airport-label',
                    });

                    m.on('click', (e) => {
                        L.DomEvent.stopPropagation(e);
                        const popup = L.popup({
                            maxWidth: 320,
                            className: 'airport-popup',
                        }).setLatLng([ap.lat, ap.lng]);

                        popup.setContent(`<div class="ap-loading">${t('scanning')} ${ap.icao}...</div>`);
                        popup.openOn(map);
                        renderMetarPopup(ap, map, popup);
                    });

                    m.addTo(airportLayerRef.current);
                }
            }
        } else {
            if (map.hasLayer(airportLayerRef.current)) {
                airportLayerRef.current.clearLayers();
                map.removeLayer(airportLayerRef.current);
            }
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

    // ===== 過濾器：判斷是否顯示飛機 (v2.3.6 Dynamic Density) =====
    const shouldShowPlane = useCallback(
        (plane, dynamicThrottle = 1.0) => {
            if (!filters.showGround && plane.onGround) return false;
            if (!filters.showEmergency && plane.isEmergency) return false;
            const alt = parseFloat(plane.altitude);
            if (!filters.showLow && !isNaN(alt) && alt < 1500) return false;

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

    // [v2.8.0] Keep a ref of planesDict for the persistent animation loop
    const planesDictRef = useRef(planesDict);
    useEffect(() => {
        planesDictRef.current = planesDict;
    }, [planesDict]);

    // ===== 同步 markers 到 planesDict (v2.8.0: Optimized Sync without Jumps) =====
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        const zoom = map.getZoom();
        const totalRawCount = Object.keys(planesDict).length;
        const dynamicThrottle = totalRawCount > 12000 ? Math.max(0.4, 12000 / totalRawCount) : 1.0;

        const MAX_MARKERS = zoom <= 4 ? 300 :
            zoom <= 5 ? 800 :
                zoom <= 6 ? 1500 :
                    zoom <= 7 ? 3500 :
                        zoom <= 8 ? 6000 : 10000;
        const showTooltips = zoom >= 6;

        const currentIds = new Set(Object.keys(planesDict));
        const markerIds = new Set(Object.keys(markersRef.current));

        // 移除不存在的 markers
        markerIds.forEach((id) => {
            if (!currentIds.has(id)) {
                map.removeLayer(markersRef.current[id]);
                delete markersRef.current[id];
            }
        });

        // 篩選通過 filter 的飛機
        const filteredPlanes = [];
        let validRegex = null;
        if (filters.regexFilter) {
            try { validRegex = new RegExp(filters.regexFilter, 'i'); } catch (e) { }
        }

        currentIds.forEach((id) => {
            const plane = planesDict[id];
            if (validRegex) {
                if (!validRegex.test(plane.callsign || '') && !validRegex.test(plane.icao24 || '') && !validRegex.test(plane.category || '')) return;
            }
            if (shouldShowPlane(plane, dynamicThrottle)) filteredPlanes.push({ id, plane });
        });

        // 優先級排序與上限控制
        let visibleSet;
        const totalInView = filteredPlanes.length;
        if (totalInView > MAX_MARKERS) {
            filteredPlanes.sort((a, b) => {
                if (a.id === selectedIcao24) return -1;
                if (b.id === selectedIcao24) return 1;
                if (a.plane.isEmergency && !b.plane.isEmergency) return -1;
                if (!a.plane.onGround && b.plane.onGround) return -1;
                return 0;
            });
            visibleSet = new Set(filteredPlanes.slice(0, MAX_MARKERS).map(p => p.id));
        } else {
            visibleSet = new Set(filteredPlanes.map(p => p.id));
        }

        if (onUsageUpdate) {
            onUsageUpdate({ visibleCount: visibleSet.size, totalInView, renderLimit: MAX_MARKERS, throttleFactor: dynamicThrottle });
        }

        // 移除超出上限或不通過篩選的 marker
        markerIds.forEach((id) => {
            if (!visibleSet.has(id) && markersRef.current[id]) {
                map.removeLayer(markersRef.current[id]);
                delete markersRef.current[id];
            }
        });

        // 新增或更新 markers 性質 (但不跳轉座標)
        visibleSet.forEach((id) => {
            const plane = planesDict[id];
            let inBounds = true;
            if (bounds) {
                const lat = parseFloat(plane.lat);
                const lng = parseFloat(plane.lng);
                const padLat = (bounds.getNorth() - bounds.getSouth()) * 0.1;
                const padLng = (bounds.getEast() - bounds.getWest()) * 0.1;
                if (lat < bounds.getSouth() - padLat || lat > bounds.getNorth() + padLat ||
                    lng < bounds.getWest() - padLng || lng > bounds.getEast() + padLng) {
                    inBounds = false;
                }
            }

            const isSelected = id === selectedIcao24;
            const { svg, size } = createPlaneSVG(plane.heading, plane.altitude, isSelected, plane.onGround, plane.isEmergency, plane.category, colorScheme);
            const extraClass = getPlaneExtraClass(plane.isEmergency, plane.onGround);

            let tooltipHtml = '';
            if (showTooltips) {
                const logoUrl = getAirlineLogoUrl(plane.callsign);
                tooltipHtml = `<div class="tactical-label css-tooltip">${logoUrl ? `<img src="${logoUrl}" onerror="this.style.display='none'" class="airline-logo">` : ''}<span>${plane.callsign}</span></div>`;
            }

            const iconHtml = `<div style="position: relative; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;">${svg}${tooltipHtml}</div>`;
            const icon = L.divIcon({ html: iconHtml, className: `plane-icon ${extraClass}`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

            if (markersRef.current[id]) {
                // [v2.8.0] CRITICAL: DO NOT setLatLng here for existing markers to prevent jumps.
                // The position is managed smoothly by the animation loop.
                const oldHtml = markersRef.current[id].options.icon?.options?.html;
                if (oldHtml !== iconHtml) markersRef.current[id].setIcon(icon);
                const el = markersRef.current[id].getElement();
                if (el) el.style.display = inBounds ? '' : 'none';
            } else if (inBounds) {
                const marker = L.marker([plane.lat, plane.lng], { icon }).addTo(map);
                marker.on('click', (e) => { L.DomEvent.stopPropagation(e); onSelectPlane(id, plane); });
                markersRef.current[id] = marker;
            }
        });
    }, [planesDict, selectedIcao24, filters, shouldShowPlane, onSelectPlane, colorScheme]);

    // ===== 軌跡與航線繪製 (v2.3.3 IDL Fix) =====
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        if (trackLineRef.current) map.removeLayer(trackLineRef.current);
        if (routeLineRef.current) map.removeLayer(routeLineRef.current);
        trackLineRef.current = null;
        routeLineRef.current = null;

        if (selectedRoute && selectedRoute.depCoord && selectedRoute.arrCoord) {
            const pathPoints = getGreatCirclePath([selectedRoute.depCoord.lat, selectedRoute.depCoord.lng], [selectedRoute.arrCoord.lat, selectedRoute.arrCoord.lng]);
            const routeSegments = splitPathAtIDL(pathPoints);
            routeLineRef.current = L.polyline(routeSegments, { color: '#94a3b8', weight: 2, opacity: 0.5, dashArray: '5, 5', interactive: false }).addTo(map);
        }

        if (trackPoints && trackPoints.length > 1) {
            const livePoints = [...trackPoints];
            if (selectedIcao24 && planesDict[selectedIcao24]) {
                const livePlane = planesDict[selectedIcao24];
                livePoints.push([livePlane.lat, livePlane.lng]);
            }

            let trackSegments = splitPathAtIDL(livePoints);
            if (trackSegments.length > 1) {
                trackSegments = trackSegments.filter(seg => seg.length > 1);
                if (trackSegments.length > 1 && Math.abs(trackSegments[0][0][1] - trackSegments[1][0][1]) < 180) {
                    trackSegments = [trackSegments.flat()];
                }
            }

            trackLineRef.current = L.polyline(trackSegments, { color: '#22d3ee', weight: 3, opacity: 0.9, dashArray: '10, 5', lineCap: 'round' }).addTo(map);
            if (routeLineRef.current) { map.removeLayer(routeLineRef.current); routeLineRef.current = null; }
            if (trackLineRef.current) trackLineRef.current.bringToFront();
        } else if (selectedIcao24 && flightHistoryRef?.current?.[selectedIcao24]) {
            const history = flightHistoryRef.current[selectedIcao24];
            if (history.length > 1) {
                const points = history.map(p => [p[1], p[2]]);
                if (planesDict[selectedIcao24]) points.push([planesDict[selectedIcao24].lat, planesDict[selectedIcao24].lng]);
                const trackSegments = splitPathAtIDL(points);
                trackLineRef.current = L.polyline(trackSegments, { color: '#f59e0b', weight: 3, opacity: 0.8, dashArray: '10, 5', lineCap: 'round' }).addTo(map);
            }
        }
    }, [trackPoints, planesDict, selectedIcao24, selectedRoute]);

    // ===== 選中飛機時移動視角 (v2.8.0: Follow current marker position, not just API data) =====
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !selectedIcao24 || !markersRef.current[selectedIcao24]) return;
        const marker = markersRef.current[selectedIcao24];
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 10), { animate: true });
    }, [selectedIcao24]);

    // ===== 動畫引擎：位置插值與微觀推算 (Dead Reckoning) [v2.8.0 Persistent Loop] =====
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        let lastTime = performance.now();

        function animate(time) {
            const deltaTimeSec = (time - lastTime) / 1000;
            lastTime = time;

            // Use planesDictRef to avoid loop resets
            const currentPlanes = planesDictRef.current || {};

            Object.entries(markersRef.current).forEach(([id, marker]) => {
                const plane = currentPlanes[id];
                if (!plane) return;

                const currentLatLng = marker.getLatLng();

                if (plane.onGround || plane.velocity <= 0 || plane.altitude === 'GROUND') {
                    // 地面目標：一般 Lerp (網路校正插值)
                    if (plane.targetLat && plane.targetLng) {
                        const lerpSpeed = 0.05; // Slightly slower for ground targets to avoid jitters
                        const newLat = currentLatLng.lat + (plane.targetLat - currentLatLng.lat) * lerpSpeed;
                        const newLng = currentLatLng.lng + (plane.targetLng - currentLatLng.lng) * lerpSpeed;
                        marker.setLatLng([newLat, newLng]);
                    }
                } else {
                    // [V2.8.0] 微觀推算 (Dead Reckoning) 2.0
                    // 1. 基於物理向量推測下一位置 (恆定平滑移動)
                    const nextPos = predictPosition(currentLatLng.lat, currentLatLng.lng, plane.velocity, plane.heading, deltaTimeSec);

                    // 2. 基於 API 目標點進行微妙校準 (LERP)
                    if (plane.targetLat && plane.targetLng) {
                        // 混合因子：0.02 (每幀向真實位置偏移 2%)，確保視覺平滑且逐漸收斂
                        const distToTargetSq = Math.pow(plane.targetLat - nextPos.lat, 2) + Math.pow(plane.targetLng - nextPos.lng, 2);

                        // 如果誤差過大 (> 0.2度)，代表座標突變（例如跳躍或回溯），則執行保護性跳轉
                        if (distToTargetSq > 0.04) {
                            marker.setLatLng([plane.targetLat, plane.targetLng]);
                        } else {
                            const correctedLat = nextPos.lat + (plane.targetLat - nextPos.lat) * 0.02;
                            const correctedLng = nextPos.lng + (plane.targetLng - nextPos.lng) * 0.02;
                            marker.setLatLng([correctedLat, correctedLng]);
                        }
                    } else {
                        // 無新資料時，純慣性物理推導
                        marker.setLatLng([nextPos.lat, nextPos.lng]);
                    }
                }

                // 軌跡更新 (保持連貫性)
                if (id === selectedIcao24 && trackLineRef.current && !plane.onGround && plane.velocity > 0) {
                    const latLngs = trackLineRef.current.getLatLngs();
                    if (latLngs.length > 0) {
                        const currentPos = { lat: marker.getLatLng().lat, lng: normalizeLongitude(marker.getLatLng().lng) };
                        const currentL = L.latLng(currentPos.lat, currentPos.lng);
                        const isMulti = Array.isArray(latLngs[0]);
                        const lastSegment = isMulti ? latLngs[latLngs.length - 1] : latLngs;
                        const lastPoint = lastSegment[lastSegment.length - 1];
                        if (lastPoint) {
                            const lastL = L.latLng(lastPoint.lat, normalizeLongitude(lastPoint.lng));
                            if (currentL.distanceTo(lastL) > 50) {
                                if (isMulti) {
                                    const newLatLngs = [...latLngs];
                                    newLatLngs[newLatLngs.length - 1] = [...lastSegment, currentPos];
                                    trackLineRef.current.setLatLngs(newLatLngs);
                                } else {
                                    trackLineRef.current.addLatLng(currentPos);
                                }
                            }
                        }
                    }
                }
            });
            animFrameRef.current = requestAnimationFrame(animate);
        }

        animFrameRef.current = requestAnimationFrame(animate);
        return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
    }, []); // Persistent loop!

    return <div ref={mapContainerRef} className="map-container" />;
}
