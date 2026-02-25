import React, { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { createPlaneSVG, getPlaneExtraClass, getAirlineLogoUrl, AIRPORTS } from '../utils/flightUtils';

/**
 * MapView — 管理 Leaflet 地圖、飛機 markers、軌跡線、機場圖層
 * 使用原生 Leaflet（非 react-leaflet）以獲得對 marker 的完全控制
 */
export default function MapView({
    planesDict,
    selectedIcao24,
    trackPoints,
    filters,
    onSelectPlane,
    onDeselectPlane,
    onMapReady,
    onMapMove,
}) {
    const mapContainerRef = useRef(null);
    const mapRef = useRef(null);
    const markersRef = useRef({});
    const trackLineRef = useRef(null);
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

    // ===== 載入機場標記 (含天氣彈窗) =====
    function loadAirports(map) {
        if (airportMarkersLoadedRef.current) return;
        airportMarkersLoadedRef.current = true;

        const layer = L.layerGroup();
        for (let i = 0; i < AIRPORTS.length; i++) {
            const ap = AIRPORTS[i];
            const m = L.marker([ap.lat, ap.lng], {
                icon: createAirportIcon(ap.type),
                interactive: true,
                zIndexOffset: -1000,
            });
            m.bindTooltip(`${ap.icao} - ${ap.name}`, {
                permanent: false,
                direction: 'right',
                offset: [10, 0],
                className: 'airport-label',
            });

            // 點擊機場 → 抓 METAR → 顯示天氣彈窗
            m.on('click', async (e) => {
                L.DomEvent.stopPropagation(e);
                const popup = L.popup({
                    maxWidth: 320,
                    className: 'airport-popup',
                }).setLatLng([ap.lat, ap.lng]);

                popup.setContent(`<div class="ap-loading">Loading ${ap.icao}...</div>`);
                popup.openOn(map);

                try {
                    const res = await fetch(`/api/metar?icao=${ap.icao}`);
                    const data = await res.json();

                    if (data.error) {
                        popup.setContent(`<div class="ap-card"><div class="ap-name">${ap.name}</div><div class="ap-icao">${ap.icao}</div><div class="ap-no-data">No weather data available</div></div>`);
                        return;
                    }

                    const windDir = data.wdir === 'VRB' ? 'Variable' : `${data.wdir}°`;
                    const windSpd = data.wspd || 0;
                    const fltCatClass = data.fltCat === 'VFR' ? 'ap-vfr' : data.fltCat === 'MVFR' ? 'ap-mvfr' : 'ap-ifr';
                    const cloudStr = data.clouds?.map(c => `${c.cover} ${c.base}ft`).join(', ') || '--';
                    const elevM = data.elev ? Math.round(data.elev * 0.3048) : '--';

                    popup.setContent(`
                        <div class="ap-card">
                            <div class="ap-name">${ap.name}</div>
                            <div class="ap-icao">${ap.icao} · Elev ${data.elev || '--'}ft (${elevM}m)</div>
                            <div class="ap-fltcat ${fltCatClass}">${data.fltCat || '--'}</div>
                            <div class="ap-grid">
                                <div class="ap-item"><span class="ap-label">🌡</span><span class="ap-val">${data.temp ?? '--'}°C</span></div>
                                <div class="ap-item"><span class="ap-label">💧</span><span class="ap-val">${data.dewp ?? '--'}°C</span></div>
                                <div class="ap-item"><span class="ap-label">🌬</span><span class="ap-val">${windDir} ${windSpd}kt</span></div>
                                <div class="ap-item"><span class="ap-label">👁</span><span class="ap-val">${data.visib ?? '--'} SM</span></div>
                                <div class="ap-item"><span class="ap-label">☁</span><span class="ap-val">${cloudStr}</span></div>
                                <div class="ap-item"><span class="ap-label">📊</span><span class="ap-val">${data.altim ?? '--'} hPa</span></div>
                            </div>
                            <div class="ap-metar">${data.rawOb || '--'}</div>
                        </div>
                    `);
                } catch (err) {
                    popup.setContent(`<div class="ap-card"><div class="ap-name">${ap.name}</div><div class="ap-no-data">Failed to load weather</div></div>`);
                }
            });

            m.addTo(layer);
        }
        airportLayerRef.current = layer;
    }

    // ===== 初始化地圖 =====
    useEffect(() => {
        if (mapRef.current) return;

        const map = L.map(mapContainerRef.current, { zoomControl: false }).setView([25.17, 121.44], 10);

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
        loadAirports(map);
        updateAirportVisibility(map);

        return () => {
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
            map.remove();
            mapRef.current = null;
        };
    }, []);

    // ===== 機場顯隱控制 =====
    function updateAirportVisibility(map) {
        if (!map || !airportLayerRef.current) return;
        const zoom = map.getZoom();
        if (zoom >= 7 && filters.showAirports) {
            if (!map.hasLayer(airportLayerRef.current)) {
                map.addLayer(airportLayerRef.current);
            }
        } else {
            if (map.hasLayer(airportLayerRef.current)) {
                map.removeLayer(airportLayerRef.current);
            }
        }
    }

    // 監聽 showAirports filter 變化
    useEffect(() => {
        const map = mapRef.current;
        if (map) updateAirportVisibility(map);
    }, [filters.showAirports]);

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

            const icon = L.divIcon({
                html: svg,
                className: `plane-icon ${extraClass}`,
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
            });

            if (markersRef.current[id]) {
                markersRef.current[id].setLatLng([plane.lat, plane.lng]);
                markersRef.current[id].setIcon(icon);
                const el = markersRef.current[id].getElement();
                if (el) el.style.display = inBounds ? '' : 'none';

                // Tooltip 可見性控制
                if (showTooltips) {
                    if (!markersRef.current[id].getTooltip()) {
                        const logoUrl = getAirlineLogoUrl(plane.callsign);
                        const logoHtml = logoUrl
                            ? `<img src="${logoUrl}" onerror="this.style.display='none'" style="max-height:20px;width:auto;vertical-align:middle;margin-right:4px;border-radius:3px">`
                            : '';
                        markersRef.current[id].bindTooltip(`${logoHtml}<span>${plane.callsign}</span>`, {
                            permanent: false,
                            direction: 'right',
                            offset: [15, 0],
                            className: 'cyber-label',
                        });
                    }
                } else {
                    if (markersRef.current[id].getTooltip()) {
                        markersRef.current[id].unbindTooltip();
                    }
                }
            } else if (inBounds) {
                const marker = L.marker([plane.lat, plane.lng], { icon }).addTo(map);

                // Tooltip（zoom >= 6 才顯示）
                if (showTooltips) {
                    const logoUrl = getAirlineLogoUrl(plane.callsign);
                    const logoHtml = logoUrl
                        ? `<img src="${logoUrl}" onerror="this.style.display='none'" style="max-height:20px;width:auto;vertical-align:middle;margin-right:4px;border-radius:3px">`
                        : '';
                    marker.bindTooltip(`${logoHtml}<span>${plane.callsign}</span>`, {
                        permanent: true,
                        direction: 'right',
                        offset: [15, 0],
                        className: 'cyber-label',
                    });
                }

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

        if (trackPoints && trackPoints.length > 1) {
            // 將選中飛機的當前位置加入軌跡線末端
            let points = [...trackPoints];
            if (selectedIcao24 && planesDict[selectedIcao24]) {
                const p = planesDict[selectedIcao24];
                points.push([p.lat, p.lng]);
            }
            trackLineRef.current = L.polyline(points, {
                color: '#FFDC00',
                weight: 3,
                opacity: 0.8,
                dashArray: '10, 5',
            }).addTo(map);
        }
    }, [trackPoints, planesDict, selectedIcao24]);

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
