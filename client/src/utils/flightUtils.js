// ==========================================
// Flight Utility Functions
// ==========================================

const EARTH_RADIUS = 6371000;

/**
 * 根據高度回傳對應顏色
 */
export function getAltitudeColor(altitude, onGround, isEmergency) {
    if (isEmergency) return '#FF4136';
    if (onGround) return '#888888';
    if (altitude === 'N/A' || altitude === 'GROUND') return '#888';
    if (altitude < 1500) return '#FF4136';
    if (altitude < 5000) return '#FFDC00';
    return '#01FF70';
}

/**
 * 產生飛機 SVG HTML
 */
export function createPlaneSVG(heading, altitude, isSelected, onGround, isEmergency) {
    const color = getAltitudeColor(altitude, onGround, isEmergency);
    const size = onGround ? 24 : Math.min(36, 24 + (altitude !== 'N/A' && altitude !== 'GROUND' ? altitude / 500 : 0));
    const glow = isSelected ? 'drop-shadow(0 0 15px #FFDC00)' : `drop-shadow(0 0 6px ${color})`;
    const planeColor = isSelected ? '#FFDC00' : color;

    const svg = `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" style="filter: ${glow};">
      <path fill="${planeColor}"
            d="M21,16V14L13,9V3.5A1.5,1.5 0 0,0 11.5,2A1.5,1.5 0 0,0 10,3.5V9L2,14V16L10,13.5V19L8,20.5V22L11.5,21L15,22V20.5L13,19V13.5L21,16Z"
            transform="rotate(${heading} 12 12)" />
    </svg>
  `;
    return { svg, size };
}

/**
 * 產生飛機的 CSS class
 */
export function getPlaneExtraClass(isEmergency, onGround) {
    if (isEmergency) return 'emergency-glow';
    if (onGround) return 'ground-glow';
    return '';
}

/**
 * 解析 OpenSky API 回傳資料
 */
export function parseOpenSkyData(data) {
    const planes = [];
    const nowUnix = Math.floor(Date.now() / 1000);

    if (!data.states) return planes;

    data.states.forEach((plane) => {
        const icao24 = plane[0];
        const lastContact = plane[4] || nowUnix;
        const dataAgeSeconds = nowUnix - lastContact;

        if (dataAgeSeconds > 120) return;

        const callsign = plane[1] ? plane[1].trim() : 'UNKNOWN';
        let altitude = plane[7] ? Math.round(plane[7]) : 'N/A';
        let onGround = plane[8];
        let velocity = plane[9] || 0;

        if (altitude !== 'N/A' && altitude < 1500 && dataAgeSeconds > 45) {
            onGround = true;
            altitude = 'GROUND';
            velocity = 0;
        }

        const pData = {
            callsign,
            country: plane[2] || 'Unknown',
            lng: plane[5],
            lat: plane[6],
            altitude,
            onGround,
            velocity,
            heading: plane[10] || 0,
            vRate: plane[11] || 0,
            squawk: plane[14] || '',
            isEmergency: ['7700', '7600', '7500'].includes(plane[14]),
            lastContact,
            registration: plane[1] ? plane[1].trim() : 'N/A',
            aircraftType: 'Unknown',
        };

        if (pData.lat && pData.lng) {
            planes.push({ icao24, data: pData });
        }
    });

    return planes;
}

/**
 * 大圓航線位置預測
 */
export function predictPosition(plane, deltaTime) {
    if (plane.onGround || plane.velocity <= 0) return { lat: plane.lat, lng: plane.lng };

    const nowUnix = Math.floor(Date.now() / 1000);
    const dataAge = nowUnix - plane.lastContact;
    if (dataAge >= 60) return { lat: plane.lat, lng: plane.lng };

    let currentVelocity = plane.velocity;
    if (plane.altitude !== 'N/A' && plane.altitude !== 'GROUND' && plane.altitude < 1500) {
        const brakingFactor = Math.max(0.1, 1 - (dataAge / 45));
        currentVelocity *= brakingFactor;
    }

    if (currentVelocity <= 0) return { lat: plane.lat, lng: plane.lng };

    const dist = currentVelocity * deltaTime;
    const brng = (plane.heading * Math.PI) / 180;
    const lat1 = (plane.lat * Math.PI) / 180;
    const lng1 = (plane.lng * Math.PI) / 180;

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(dist / EARTH_RADIUS) +
        Math.cos(lat1) * Math.sin(dist / EARTH_RADIUS) * Math.cos(brng)
    );
    const lng2 =
        lng1 +
        Math.atan2(
            Math.sin(brng) * Math.sin(dist / EARTH_RADIUS) * Math.cos(lat1),
            Math.cos(dist / EARTH_RADIUS) - Math.sin(lat1) * Math.sin(lat2)
        );

    return {
        lat: (lat2 * 180) / Math.PI,
        lng: (lng2 * 180) / Math.PI,
    };
}

/**
 * 格式化垂直速率
 */
export function formatVerticalRate(vRate) {
    if (!vRate) return '→ Level';
    if (vRate > 0.5) return `↗ ${vRate.toFixed(1)} m/s`;
    if (vRate < -0.5) return `↘ ${vRate.toFixed(1)} m/s`;
    return '→ Level';
}

/**
 * 取得航空公司 Logo URL
 */
export function getAirlineLogoUrl(callsign) {
    if (!callsign || callsign === 'UNKNOWN') return '';
    return `https://cdn.flightradar24.com/assets/airlines/logotypes/${callsign.substring(0, 3)}.png`;
}
