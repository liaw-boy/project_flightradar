import React, { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { createPlaneSVG, getPlaneExtraClass, getAirlineLogoUrl } from '../utils/flightUtils';
import { GLOBAL_AIRPORTS } from '../utils/airportMappings';

/**
 * MapView — 管理 Leaflet 地圖、飛機 markers、軌跡線、機場圖層
 * 使用原生 Leaflet（非 react-leaflet）以獲得對 marker 的完全控制
 */
export default function MapView({
    planesDict,
    selectedIcao24,
    trackPoints,
    filters,
    selectedRoute, // ADDED PROPS
    onSelectPlane,
    onDeselectPlane,
    onMapReady,
    onMapMove,
    t,
    translateMetar,
}) {
    const mapContainerRef = useRef(null);
    const mapRef = useRef(null);
    const markersRef = useRef({});
    const trackLineRef = useRef(null);
    const predictiveLineRef = useRef(null); // ADDED REF
    const animFrameRef = useRef(null);
    const lastDrawTimeRef = useRef(performance.now());
    const airportLayerRef = useRef(null);
    const airportMarkersLoadedRef = useRef(false);

    const [bounds, setBounds] = useState(null);

    // ===== 機場圖標 SVG =====
    function createAirportIcon(type) {
        const size = type === 'large' ? 14 : type === 'medium' ? 10 : 8;
        const svg = `<svg viewBox="0 0 24 24" width="${size * 2}" height="${size * 2}"><circle cx="12" cy="12" r="10" fill="none" stroke="#00BFFF" stroke-width="2" opacity="0.6"/><circle cx="12" cy="12" r="4" fill="#00BFFF" opacity="0.8"/></svg>`;
        return L.divIcon({ html: svg, className: 'airport-icon', iconSize: [size * 2, size * 2], iconAnchor: [size, size] });
    }

    // ===== 機場圖層初始化 =====
    const renderMetarPopup = async (ap, map, popup) => {
        try {
            const res = await fetch(`/api/metar?icao=${ap.icao}`);
            const data = await res.json();

            if (data.error) {
                popup.setContent(`<div class="ap-card"><div class="ap-name">${ap.name}</div><div class="ap-icao">${ap.icao}</div><div class="ap-no-data">${t?.('weatherData') || 'No weather data available'}</div></div>`);
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

            popup.setContent(`
                        <div class="ap-card">
                            <div class="ap-name">${ap.name}</div>
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
                                    <span class="ap-val">${cloudStr}</span>
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
            popup.setContent(`<div class="ap-card"><div class="ap-name">${ap.name}</div><div class="ap-no-data">${t?.('weatherFailed') || 'Failed to load weather'}</div></div>`);
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
            onMapMove?.();
        });

        // 機場圖層 zoom 控制
        map.on('zoomend', () => {
            updateAirportVisibility(map);
        });

        mapRef.current = map;
        onMapReady?.(map);

        // 初始載入機場
        airportLayerRef.current = L.layerGroup();
        updateAirportVisibility(map);

        return () => {
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
            map.remove();
            mapRef.current = null;
        };
    }, []);

    // ===== 機場顯隱與虛擬化渲染 (Virtualized Rendering) =====
    function updateAirportVisibility(map) {
        if (!map || !airportLayerRef.current) return;
        const zoom = map.getZoom();
        const bounds = map.getBounds();

        // Zoom 5 starts showing major continental airports, keeps performance decent
        if (zoom >= 5 && filters.showAirports) {
            if (!map.hasLayer(airportLayerRef.current)) {
                map.addLayer(airportLayerRef.current);
            }

            // 虛擬化: 清空不在畫面中的 marker，只渲染當前邊界內的機場
            airportLayerRef.current.clearLayers();
            const extBounds = bounds.pad(0.3); // Pad view by 30% for smooth panning

            for (let i = 0; i < GLOBAL_AIRPORTS.length; i++) {
                const ap = GLOBAL_AIRPORTS[i];
                if (extBounds.contains([ap.lat, ap.lng])) {
                    const m = L.marker([ap.lat, ap.lng], {
                        icon: createAirportIcon(ap.type),
                        interactive: true,
                        zIndexOffset: -1000,
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

                        popup.setContent(`<div class="ap-loading">Loading ${ap.icao}...</div>`);
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
        const map = mapRef.current;
        if (map) {
            // Persistent Popup Logic: If a popup is open, check if it's an airport card and re-render it
            const openPopup = map._popup;
            if (openPopup && openPopup.isOpen()) {
                const el = openPopup.getElement();
                const apCard = el?.querySelector('.ap-card');
                if (apCard) {
                    const icaoMatch = el.querySelector('.ap-icao')?.textContent.split(' · ')[0];
                    if (icaoMatch) {
                        const apData = GLOBAL_AIRPORTS.find(a => a.icao === icaoMatch);
                        if (apData) {
                            renderMetarPopup(apData, map, openPopup);
                        }
                    }
                }
            }
            updateAirportVisibility(map);
        }
    }, [filters.showAirports, t, translateMetar]);

    // ===== 過濾器：判斷是否顯示飛機 =====
    const shouldShowPlane = useCallback(
        (plane) => {
            if (!filters.showGround && plane.onGround) return false;
            if (!filters.showEmergency && plane.isEmergency) return false;
            if (!filters.showLow && plane.altitude !== 'N/A' && plane.altitude !== 'GROUND' && plane.altitude < 1500) return false;

            // Local Bounds Check for Zero-Latency Panning
            if (bounds) {
                const lat = parseFloat(plane.lat);
                const lng = parseFloat(plane.lng);
                if (lat < bounds.getSouth() || lat > bounds.getNorth() || lng < bounds.getWest() || lng > bounds.getEast()) {
                    return false;
                }
            }
            return true;
        },
        [filters, bounds]
    );

    // ===== 同步 markers 到 planesDict =====
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        const zoom = map.getZoom();

        // 根據 zoom 設定 marker 上限 (防止卡頓)
        const MAX_MARKERS = zoom <= 4 ? 300 : zoom <= 5 ? 800 : zoom <= 6 ? 2000 : 99999;
        const showTooltips = zoom >= 6; // 低縮放隱藏 tooltip 以提升效能

        const currentIds = new Set(Object.keys(planesDict));
        const markerIds = new Set(Object.keys(markersRef.current));

        // 移除不存在的 markers
        markerIds.forEach((id) => {
            if (!currentIds.has(id)) {
                map.removeLayer(markersRef.current[id]);
                delete markersRef.current[id];
            }
        });

        // 篩選通過 filter 的飛機列表
        const filteredPlanes = [];
        currentIds.forEach((id) => {
            const plane = planesDict[id];
            if (!filters.showGround && plane.onGround) return;
            if (!filters.showEmergency && plane.isEmergency) return;
            if (!filters.showLow && plane.altitude !== 'N/A' && plane.altitude !== 'GROUND' && plane.altitude < 1500) return;
            filteredPlanes.push({ id, plane });
        });

        // 如果飛機數超過上限，優先保留重要飛機
        let visibleSet;
        if (filteredPlanes.length > MAX_MARKERS) {
            filteredPlanes.sort((a, b) => {
                // 選中飛機最優先
                if (a.id === selectedIcao24) return -1;
                if (b.id === selectedIcao24) return 1;
                // 緊急優先
                if (a.plane.isEmergency && !b.plane.isEmergency) return -1;
                if (!a.plane.isEmergency && b.plane.isEmergency) return 1;
                // 空中 > 地面
                if (!a.plane.onGround && b.plane.onGround) return -1;
                if (a.plane.onGround && !b.plane.onGround) return 1;
                return 0;
            });
            visibleSet = new Set(filteredPlanes.slice(0, MAX_MARKERS).map(p => p.id));
        } else {
            visibleSet = new Set(filteredPlanes.map(p => p.id));
        }

        // 移除超出上限或不通過篩選的 marker
        markerIds.forEach((id) => {
            if (!visibleSet.has(id) && markersRef.current[id]) {
                map.removeLayer(markersRef.current[id]);
                delete markersRef.current[id];
            }
        });

        // 新增或更新 markers
        visibleSet.forEach((id) => {
            const plane = planesDict[id];

            // Bounds check — 不在視野內的隱藏
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
            const { svg, size } = createPlaneSVG(plane.heading, plane.altitude, isSelected, plane.onGround, plane.isEmergency, plane.category);
            const extraClass = getPlaneExtraClass(plane.isEmergency, plane.onGround);

            let tooltipHtml = '';
            if (showTooltips) {
                const logoUrl = getAirlineLogoUrl(plane.callsign);
                const logoHtml = logoUrl
                    ? `<img src="${logoUrl}" onerror="this.style.display='none'" class="airline-logo">`
                    : '';
                tooltipHtml = `<div class="cyber-label css-tooltip">${logoHtml}<span>${plane.callsign}</span></div>`;
            }

            const iconHtml = `
                <div style="position: relative; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;">
                    ${svg}
                    ${tooltipHtml}
                </div>
            `;

            const icon = L.divIcon({
                html: iconHtml,
                className: `plane-icon ${extraClass}`,
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
            });

            if (markersRef.current[id]) {
                markersRef.current[id].setLatLng([plane.lat, plane.lng]);

                // Only update the icon if the HTML actually changed.
                // This preserves DOM state (like standard CSS :hover) and prevents tooltips from sticking.
                const oldHtml = markersRef.current[id].options.icon?.options?.html;
                if (oldHtml !== iconHtml) {
                    markersRef.current[id].setIcon(icon);
                }

                const el = markersRef.current[id].getElement();
                if (el) el.style.display = inBounds ? '' : 'none';
            } else if (inBounds) {
                const marker = L.marker([plane.lat, plane.lng], { icon }).addTo(map);

                marker.on('click', (e) => {
                    L.DomEvent.stopPropagation(e);
                    onSelectPlane(id, plane);
                });

                markersRef.current[id] = marker;
            }
        });
    }, [planesDict, selectedIcao24, filters, shouldShowPlane, onSelectPlane]);

    // ===== 軌跡線 =====
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;

        if (trackLineRef.current) {
            map.removeLayer(trackLineRef.current);
            trackLineRef.current = null;
        }

        const getDistMap = (lat1, lon1, lat2, lon2) => {
            const R = 6371e3;
            const φ1 = lat1 * Math.PI / 180;
            const φ2 = lat2 * Math.PI / 180;
            const Δφ = (lat2 - lat1) * Math.PI / 180;
            const Δλ = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        };

        if (trackPoints && trackPoints.length > 1) {
            // Dynamically append the plane's live position to the static history track
            // so the line doesn't fall behind as the plane moves.
            const livePoints = [...trackPoints];
            if (selectedIcao24 && planesDict[selectedIcao24]) {
                const livePlane = planesDict[selectedIcao24];
                const trackEnd = livePoints[livePoints.length - 1];

                // Anti-Glitch: Only connect if the jump is less than 500km.
                // If OpenSky returns yesterday's track, this prevents a massive cross-continent straight line.
                const dist = getDistMap(trackEnd[0], trackEnd[1], livePlane.lat, livePlane.lng);
                if (dist < 500000) {
                    livePoints.push([livePlane.lat, livePlane.lng]);
                }
            }

            trackLineRef.current = L.polyline(livePoints, {
                color: '#FFDC00',
                weight: 3,
                opacity: 0.8,
                dashArray: '10, 5',
                lineCap: 'round',
            }).addTo(map);
        }

        // ===== 預估虛線 (Predictive Path) =====
        if (predictiveLineRef.current) {
            map.removeLayer(predictiveLineRef.current);
            predictiveLineRef.current = null;
        }

        if (selectedIcao24 && planesDict[selectedIcao24] && selectedRoute) {
            const livePlane = planesDict[selectedIcao24];
            const livePos = [livePlane.lat, livePlane.lng];
            const predPoints = [];

            // Helper to find airport coordinates from the massive GLOBAL_AIRPORTS array
            const getApCoords = (icao) => {
                if (!icao) return null;
                const ap = GLOBAL_AIRPORTS.find(a => a.icao === icao.toUpperCase());
                return ap ? [ap.lat, ap.lng] : null;
            };

            const originCoords = getApCoords(selectedRoute.origin);
            const destCoords = getApCoords(selectedRoute.destination);

            if (originCoords) predPoints.push(originCoords);
            predPoints.push(livePos);
            if (destCoords) predPoints.push(destCoords);

            if (predPoints.length > 1) {
                predictiveLineRef.current = L.polyline(predPoints, {
                    color: '#888888',
                    weight: 2,
                    opacity: 0.5,
                    dashArray: '5, 10',
                    lineCap: 'round',
                }).addTo(map);

                // Make sure the yellow actual track renders *above* the grey prediction line
                if (trackLineRef.current) {
                    trackLineRef.current.bringToFront();
                }
            }
        }
    }, [trackPoints, planesDict, selectedIcao24, selectedRoute]);

    // ===== 選中飛機時移動視角 =====
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !selectedIcao24 || !planesDict[selectedIcao24]) return;

        const plane = planesDict[selectedIcao24];
        map.setView([plane.lat, plane.lng], Math.max(map.getZoom(), 10), { animate: true });
    }, [selectedIcao24]);

    // ===== 動畫引擎：位置插值 =====
    useEffect(() => {
        function animate() {
            Object.entries(markersRef.current).forEach(([id, marker]) => {
                const plane = planesDict[id];
                if (!plane) return;

                if (plane.targetLat && plane.targetLng) {
                    const lerpSpeed = 0.08;
                    const currentLatLng = marker.getLatLng();
                    const newLat = currentLatLng.lat + (plane.targetLat - currentLatLng.lat) * lerpSpeed;
                    const newLng = currentLatLng.lng + (plane.targetLng - currentLatLng.lng) * lerpSpeed;
                    marker.setLatLng([newLat, newLng]);
                }
            });

            animFrameRef.current = requestAnimationFrame(animate);
        }

        animFrameRef.current = requestAnimationFrame(animate);
        return () => {
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        };
    }, [planesDict]);

    return <div ref={mapContainerRef} className="map-container" />;
}
