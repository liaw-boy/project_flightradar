import React from 'react';
import { useI18n } from '../hooks/useI18n';
import {
    getAirlineLogoUrl,
    getAirlineName,
    getCountryFlag,
    getCategoryName,
    getNearestAirport,
    formatVerticalRate,
} from '../utils/flightUtils';
import './Sidebar.css';

export default function Sidebar({ plane, icao24, metadata, route, onClose }) {
    if (!plane || !icao24) return null;

    const { t } = useI18n();
    const logoUrl = getAirlineLogoUrl(plane.callsign);
    const nowUnix = Math.floor(Date.now() / 1000);
    const dataAge = nowUnix - (plane.lastContact || nowUnix);
    const contactTime = new Date((plane.lastContact || nowUnix) * 1000).toLocaleTimeString();
    const fr24Url = `https://www.flightradar24.com/${plane.callsign}`;

    const airlineName = getAirlineName(plane.callsign);
    const flag = getCountryFlag(plane.country);
    const categoryName = metadata?.categoryDescription || getCategoryName(plane.category);
    const nearest = getNearestAirport(plane.lat, plane.lng);
    const posSourceMap = { 0: 'ADS-B', 1: 'ASTERIX', 2: 'MLAT', 3: 'FLARM' };

    // 飛機型號 (from metadata)
    const aircraftModel = metadata
        ? [metadata.manufacturerName, metadata.model].filter(Boolean).join(' ') || 'Unknown'
        : plane.aircraftType || 'Loading...';
    const typecode = metadata?.typecode || '';
    const registration = metadata?.registration || plane.registration || 'N/A';

    // 航線 (from route)
    const dep = route?.departureAirport || null;
    const arr = route?.arrivalAirport || null;

    return (
        <div className="sidebar active">
            <div className="sb-header">
                <h2 className="sb-title">{plane.callsign || 'UNKNOWN'}</h2>
                <div className="sb-close" onClick={onClose}>×</div>
            </div>

            <div className="sb-content">
                {plane.isEmergency && (
                    <div className="alert-box visible">🚨 EMERGENCY SQUAWK: {plane.squawk}</div>
                )}

                {/* Logo */}
                {logoUrl && (
                    <div className="sb-logo-container">
                        <img src={logoUrl} alt="Airline Logo" onError={(e) => (e.target.style.display = 'none')} />
                    </div>
                )}

                {/* Route (出發 → 目的地) */}
                {(dep || arr) && (
                    <div className="sb-route-banner">
                        <span className="sb-route-airport">{dep || '???'}</span>
                        <span className="sb-route-arrow">✈ →</span>
                        <span className="sb-route-airport">{arr || '???'}</span>
                    </div>
                )}
                {!dep && !arr && route === null && (
                    <div className="sb-route-banner sb-route-loading">
                        Loading route...
                    </div>
                )}

                {/* Flight Identity */}
                <div className="sb-section-title">{t('flightIdentity')}</div>
                <DataRow label={t('icao24')} value={icao24.toUpperCase()} />
                <DataRow label={t('registration')} value={registration} />
                <DataRow label={t('country')} value={`${flag} ${plane.country || 'Unknown'}`} />
                <DataRow label={t('airline')} value={airlineName || '--'} />
                <DataRow label={t('category')} value={categoryName} />
                <DataRow label={t('type')} value={typecode ? `${typecode} — ${aircraftModel}` : aircraftModel} />
                {metadata?.owner && <DataRow label="Owner" value={metadata.owner} />}

                {/* Spatial Data */}
                <div className="sb-section-title">{t('spatialData')}</div>
                <DataRow label={t('altitude')} value={plane.onGround ? 'GROUND' : `${plane.altitude} m`} />
                {plane.geoAltitude && (
                    <DataRow label={t('gpsAlt')} value={`${plane.geoAltitude} m`} />
                )}
                <DataRow label={t('speed')} value={`${Math.round(plane.velocity * 3.6)} km/h`} />
                <DataRow label={t('heading')} value={`${Math.round(plane.heading)}°`} />
                <DataRow label={t('vertRate')} value={formatVerticalRate(plane.vRate)} />
                <DataRow label={t('position')} value={`${plane.lat.toFixed(4)}, ${plane.lng.toFixed(4)}`} />
                <DataRow label={t('source')} value={posSourceMap[plane.positionSource] || 'Unknown'} />

                {/* Status */}
                <div className="sb-section-title">{t('status')}</div>
                <DataRow label={t('squawk')} value={plane.squawk || '--'} />
                <DataRow
                    label={t('spiLabel')}
                    value={plane.spi ? '⚠️ ACTIVE' : 'Normal'}
                    valueClass={plane.spi ? 'spi-active' : ''}
                />
                <DataRow label={t('lastContact')} value={contactTime} />
                <DataRow label={t('dataAge')} value={`${dataAge}s ago`} />

                {/* Nearest Airport */}
                {nearest && (
                    <>
                        <div className="sb-section-title">{t('nearestAirport')}</div>
                        <DataRow label={t('airport')} value={`${nearest.airport.icao} - ${nearest.airport.name}`} />
                        <DataRow label={t('distance')} value={`${nearest.distance} km`} />
                    </>
                )}

                {/* FR24 連結 */}
                <a href={fr24Url} target="_blank" rel="noopener noreferrer" className="route-btn">
                    {t('trackOnFR24')}
                </a>
            </div>
        </div>
    );
}

function DataRow({ label, value, valueClass = '' }) {
    return (
        <div className="sb-data-row">
            <span className="sb-data-label">{label}</span>
            <span className={`sb-data-value ${valueClass}`}>{value}</span>
        </div>
    );
}
