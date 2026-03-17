import L from 'leaflet';
import { getAircraftIconType, getAltitudeColor, AIRCRAFT_SVGS } from '../utils/aircraftIcons';

/**
 * 建立飛機標記 (Vanilla Leaflet 版本)
 */
export function createAircraftMarker(plane) {
    const {
        icao24,
        callsign,
        latitude,
        longitude,
        altitude,
        heading,
        aircraft_type
    } = plane;

    const iconType = getAircraftIconType(aircraft_type);
    const color = getAltitudeColor(altitude);
    const svgPath = AIRCRAFT_SVGS[iconType] || AIRCRAFT_SVGS.default_jet;

    const icon = L.divIcon({
        className: 'aircraft-marker-container',
        html: `
            <div class="aircraft-marker-wrapper" style="
                transform: rotate(${heading}deg);
                color: ${color};
            ">
                <svg viewBox="0 0 100 100" class="aircraft-svg">
                    <path d="${svgPath}" fill="currentColor" />
                </svg>
            </div>
        `,
        iconSize: [40, 40],
        iconAnchor: [20, 20],
    });

    const marker = L.marker([latitude, longitude], { icon });
    
    // Tooltip
    marker.bindTooltip(`
        <div class="plane-tooltip">
            <strong>${callsign || icao24}</strong><br />
            <span>${aircraft_type || 'Unknown'}</span><br />
            <span>Alt: ${Math.round(altitude)}m</span>
        </div>
    `, { direction: 'top', offset: [0, -20], opacity: 0.9 });

    return marker;
}

/**
 * 更新既有標記的屬性 (避開重新建立 DOM)
 */
export function updateAircraftMarker(marker, plane) {
    const {
        latitude,
        longitude,
        altitude,
        heading,
        aircraft_type
    } = plane;

    // 更新位置
    marker.setLatLng([latitude, longitude]);

    // 更新 Icon (包含顏色與旋轉)
    const iconType = getAircraftIconType(aircraft_type);
    const color = getAltitudeColor(altitude);
    const svgPath = AIRCRAFT_SVGS[iconType] || AIRCRAFT_SVGS.default_jet;

    marker.setIcon(L.divIcon({
        className: 'aircraft-marker-container',
        html: `
            <div class="aircraft-marker-wrapper" style="
                transform: rotate(${heading}deg);
                color: ${color};
            ">
                <svg viewBox="0 0 100 100" class="aircraft-svg">
                    <path d="${svgPath}" fill="currentColor" />
                </svg>
            </div>
        `,
        iconSize: [40, 40],
        iconAnchor: [20, 20],
    }));

    // 更新 Tooltip (可選，通常 callsign 不太變)
    return marker;
}
