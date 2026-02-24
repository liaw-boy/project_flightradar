import React from 'react';
import { getAirlineLogoUrl, formatVerticalRate } from '../utils/flightUtils';
import './Sidebar.css';

export default function Sidebar({ plane, icao24, onClose }) {
    if (!plane || !icao24) return null;

    const logoUrl = getAirlineLogoUrl(plane.callsign);
    const nowUnix = Math.floor(Date.now() / 1000);
    const dataAge = nowUnix - (plane.lastContact || nowUnix);
    const contactTime = new Date((plane.lastContact || nowUnix) * 1000).toLocaleTimeString();
    const fr24Url = `https://www.flightradar24.com/${plane.callsign}`;

    return (
        <div className="sidebar active">
            {/* Header */}
            <div className="sb-header">
                <h2 className="sb-title">{plane.callsign || 'UNKNOWN'}</h2>
                <div className="sb-close" onClick={onClose}>×</div>
            </div>

            <div className="sb-content">
                {/* 緊急警報 */}
                {plane.isEmergency && (
                    <div className="alert-box visible">🚨 EMERGENCY SQUAWK: {plane.squawk}</div>
                )}

                {/* Logo */}
                {logoUrl && (
                    <div className="sb-logo-container">
                        <img src={logoUrl} alt="Airline Logo" onError={(e) => (e.target.style.display = 'none')} />
                    </div>
                )}

                {/* Flight Identity */}
                <div className="sb-section-title">✈️ FLIGHT IDENTITY</div>
                <DataRow label="ICAO24" value={icao24.toUpperCase()} />
                <DataRow label="Registration" value={plane.registration || 'N/A'} />
                <DataRow label="Country" value={plane.country || 'Unknown'} />
                <DataRow label="Type" value={plane.aircraftType || 'Unknown'} />

                {/* Spatial Data */}
                <div className="sb-section-title">📊 SPATIAL DATA</div>
                <DataRow label="Altitude" value={plane.onGround ? 'GROUND' : `${plane.altitude} m`} />
                <DataRow label="Speed" value={`${Math.round(plane.velocity * 3.6)} km/h`} />
                <DataRow label="Heading" value={`${Math.round(plane.heading)}°`} />
                <DataRow label="Vert. Rate" value={formatVerticalRate(plane.vRate)} />
                <DataRow label="Position" value={`${plane.lat.toFixed(4)}, ${plane.lng.toFixed(4)}`} />

                {/* Timing */}
                <div className="sb-section-title">⏱️ TIMING</div>
                <DataRow label="Last Contact" value={contactTime} />
                <DataRow label="Data Age" value={`${dataAge}s ago`} />

                {/* FR24 連結 */}
                <a href={fr24Url} target="_blank" rel="noopener noreferrer" className="route-btn">
                    🔍 Track on Flightradar24 ↗
                </a>
            </div>
        </div>
    );
}

function DataRow({ label, value }) {
    return (
        <div className="sb-data-row">
            <span className="sb-data-label">{label}</span>
            <span className="sb-data-value">{value}</span>
        </div>
    );
}
