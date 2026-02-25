import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { createPlaneSVG, getPlaneExtraClass, getAirlineLogoUrl } from '../utils/flightUtils';

/**
 * MapView — 管理 Leaflet 地圖、飛機 markers、軌跡線、動畫引擎
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

    const [bounds, setBounds] = useState(null);

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

        // 地圖移動結束時通知
        map.on('moveend', () => {
            setBounds(map.getBounds());
            if (map.getZoom() >= 6) {
                onMapMove?.();
            }
        });

        mapRef.current = map;
        onMapReady?.(map);

        return () => {
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
            map.remove();
            mapRef.current = null;
        };
    }, []);

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
                // Simple bounds check
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

        const currentIds = new Set(Object.keys(planesDict));
        const markerIds = new Set(Object.keys(markersRef.current));

        // 移除不存在的 markers
        markerIds.forEach((id) => {
            if (!currentIds.has(id)) {
                map.removeLayer(markersRef.current[id]);
                delete markersRef.current[id];
            }
        });

        // 新增或更新 markers
        currentIds.forEach((id) => {
            const plane = planesDict[id];
            const show = shouldShowPlane(plane);

            if (!show) {
                if (markersRef.current[id]) {
                    map.removeLayer(markersRef.current[id]);
                    delete markersRef.current[id];
                }
                return;
            }

            const isSelected = id === selectedIcao24;
            const { svg, size } = createPlaneSVG(plane.heading, plane.altitude, isSelected, plane.onGround, plane.isEmergency);
            const extraClass = getPlaneExtraClass(plane.isEmergency, plane.onGround);

            const icon = L.divIcon({
                html: svg,
                className: `plane-icon ${extraClass}`,
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
            });

            if (markersRef.current[id]) {
                // 更新現有 marker
                markersRef.current[id].setLatLng([plane.lat, plane.lng]);
                markersRef.current[id].setIcon(icon);
            } else {
                // 建立新 marker
                const marker = L.marker([plane.lat, plane.lng], { icon }).addTo(map);

                // Tooltip
                const logoUrl = getAirlineLogoUrl(plane.callsign);
                const tooltipHtml = `<img src="${logoUrl}" onerror="this.style.display='none'" style="max-height:14px;width:auto;filter:brightness(1.2)"><span>${plane.callsign}</span>`;
                marker.bindTooltip(tooltipHtml, {
                    permanent: true,
                    direction: 'right',
                    offset: [15, 0],
                    className: 'cyber-label',
                });

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

        // 移除舊軌跡
        if (trackLineRef.current) {
            map.removeLayer(trackLineRef.current);
            trackLineRef.current = null;
        }

        if (trackPoints && trackPoints.length > 1) {
            trackLineRef.current = L.polyline(trackPoints, {
                color: '#FFDC00',
                weight: 3,
                opacity: 0.8,
                dashArray: '10, 5',
            }).addTo(map);
        }
    }, [trackPoints]);

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
            const now = performance.now();
            const deltaTime = (now - lastDrawTimeRef.current) / 1000;
            lastDrawTimeRef.current = now;

            Object.entries(markersRef.current).forEach(([id, marker]) => {
                const plane = planesDict[id];
                if (!plane) return;

                // 插值到目標位置
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
