import React, { useState, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, useMap } from 'react-leaflet';

// ─── Shortest-path longitude adjustment (antimeridian-aware) ─────────────────
// Returns a possibly-unwrapped lng2 so that |adjLng2 - lng1| ≤ 180.
// e.g. US (-100°) → Japan (140°):  raw dLng = +240 → adjLng2 = 140-360 = -220
//      arc goes westward through the Pacific (correct).
function shortestLng(lng1, lng2) {
    const d = lng2 - lng1;
    if (d > 180)  return lng2 - 360;
    if (d < -180) return lng2 + 360;
    return lng2;
}

// ─── Quadratic bezier arc (antimeridian-aware, shortest-path) ─────────────────
export function curvePts(lat1, lng1, lat2, lng2, n = 40) {
    const adjLng2 = shortestLng(lng1, lng2);
    const dLat = lat2 - lat1;
    const dLng = adjLng2 - lng1;
    const dist = Math.sqrt(dLat * dLat + dLng * dLng);
    if (dist < 0.01) return [[lat1, lng1], [lat2, adjLng2]];
    const lift = dist * 0.2;
    const ctrlLat = (lat1 + lat2) / 2 - (dLng / dist) * lift;
    const ctrlLng = (lng1 + adjLng2) / 2 + (dLat / dist) * lift;
    return Array.from({ length: n + 1 }, (_, i) => {
        const t = i / n, mt = 1 - t;
        return [
            mt * mt * lat1 + 2 * mt * t * ctrlLat + t * t * lat2,
            mt * mt * lng1 + 2 * mt * t * ctrlLng + t * t * adjLng2,
        ];
    });
}

// ─── Map bounds controller (react-leaflet inner component) ────────────────────
function MapBoundsCtrl({ bounds }) {
    const map = useMap();
    useEffect(() => {
        if (bounds) map.fitBounds(bounds, { padding: [20, 20], animate: false, maxZoom: 6 });
    }, [map, bounds]);
    return null;
}

// ─── Fix Leaflet size when container was off-screen during init ────────────────
function MapResizer() {
    const map = useMap();
    useEffect(() => {
        const t = setTimeout(() => map.invalidateSize(), 550);
        return () => clearTimeout(t);
    }, [map]);
    return null;
}

// ─── Theme hook ───────────────────────────────────────────────────────────────
export function useIsDark() {
    const [isDark, setIsDark] = useState(() => document.documentElement.getAttribute('data-theme') !== 'light');
    useEffect(() => {
        const obs = new MutationObserver(() =>
            setIsDark(document.documentElement.getAttribute('data-theme') !== 'light')
        );
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => obs.disconnect();
    }, []);
    return isDark;
}

// ─── Mini Route Map (Leaflet real tiles + great-circle arc) ───────────────────
const MiniRouteMap = React.memo(function MiniRouteMap({ depInfo, arrInfo }) {
    const isDark = useIsDark();
    if (!depInfo?.lat || !depInfo?.lng || !arrInfo?.lat || !arrInfo?.lng) return null;

    // adjLng2: arrival longitude adjusted for shortest path (may exceed ±180)
    const adjArrLng = useMemo(() =>
        shortestLng(depInfo.lng, arrInfo.lng),
    [depInfo.lng, arrInfo.lng]);

    const arcPoints = useMemo(() =>
        curvePts(depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng),
    [depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng]);

    const mapInit = useMemo(() => ({
        center: [(depInfo.lat + arrInfo.lat) / 2, (depInfo.lng + adjArrLng) / 2],
        zoom: 2,
    }), [depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng, adjArrLng]);

    const mapBounds = useMemo(() => [
        [depInfo.lat, depInfo.lng],
        [arrInfo.lat, adjArrLng],
    ], [depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng, adjArrLng]);

    const tileUrl = isDark
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

    if (!arcPoints.length) return null;

    return (
        <div style={{ margin: '0 12px 12px', borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--border)' }}>
            <MapContainer
                key={isDark ? 'dark' : 'light'}
                style={{ height: '145px', width: '100%' }}
                center={mapInit.center}
                zoom={mapInit.zoom}
                zoomControl={false}
                attributionControl={false}
                dragging={false}
                touchZoom={false}
                scrollWheelZoom={false}
                doubleClickZoom={false}
                boxZoom={false}
                keyboard={false}
            >
                <MapResizer />
                <MapBoundsCtrl bounds={mapBounds} />
                <TileLayer url={tileUrl} />
                <Polyline
                    positions={arcPoints}
                    pathOptions={{ color: '#22d3ee', weight: 2, opacity: 0.75, dashArray: '6 4' }}
                />
                <CircleMarker
                    center={arcPoints[0]}
                    radius={5}
                    pathOptions={{ color: '#22d3ee', fillColor: '#22d3ee', fillOpacity: 1, weight: 2 }}
                />
                <CircleMarker
                    center={arcPoints[arcPoints.length - 1]}
                    radius={5}
                    pathOptions={{ color: '#10b981', fillColor: '#10b981', fillOpacity: 1, weight: 2 }}
                />
            </MapContainer>
        </div>
    );
}, (prev, next) =>
    prev.depInfo?.lat === next.depInfo?.lat &&
    prev.depInfo?.lng === next.depInfo?.lng &&
    prev.arrInfo?.lat === next.arrInfo?.lat &&
    prev.arrInfo?.lng === next.arrInfo?.lng
);

export default MiniRouteMap;
