import React, { useState, useEffect } from 'react';
import { useI18n } from '../hooks/useI18n';
import {
    getAirlineLogoUrl,
    getAirlineName,
    getCountryFlag,
    getCategoryName,
    getNearestAirport,
    formatVerticalRate,
    getAirportDisplayData,
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
    const isLoadingRoute = route === null;
    const dep = route?.departureAirport || (route?.noData ? 'N/A' : '...');
    const arr = route?.arrivalAirport || (route?.noData ? 'N/A' : '...');

    // Convert ICAO to IATA and get City Name
    const depData = getAirportDisplayData(dep);
    const arrData = getAirportDisplayData(arr);

    const [photos, setPhotos] = useState([]);
    const [openSections, setOpenSections] = useState({
        spatial: false,
        status: false,
        nearest: false
    });

    const toggleSection = (section) => {
        setOpenSections(prev => ({ ...prev, [section]: !prev[section] }));
    };

    useEffect(() => {
        let isMounted = true;
        setPhotos([]);
        if (icao24) {
            fetch(`https://api.planespotters.net/pub/photos/hex/${icao24}`)
                .then(res => res.json())
                .then(data => {
                    if (isMounted && data.photos && data.photos.length > 0) {
                        setPhotos(data.photos);
                    }
                })
                .catch(err => console.error("Error fetching photo:", err));
        }
        return () => { isMounted = false; };
    }, [icao24]);

    return (
        <div className="sidebar active">
            <div className="sb-header">
                <div>
                    <h2 className="sb-title">
                        {plane.callsign || 'UNKNOWN'}
                        {typecode && <span className="sb-badge">{typecode}</span>}
                    </h2>
                    <div className="sb-subtitle">
                        {airlineName || 'Unknown Airline'}
                    </div>
                </div>
                <div className="sb-close" onClick={onClose}>×</div>
            </div>

            <div className="sb-content">
                {plane.isEmergency && (
                    <div className="alert-box visible">🚨 EMERGENCY SQUAWK: {plane.squawk}</div>
                )}

                {/* Photo Banner / Carousel */}
                {photos.length > 0 ? (
                    <div className="sb-photo-carousel">
                        {photos.map((photo, index) => (
                            <div key={index} className="sb-photo-slide">
                                <img src={photo.thumbnail_large?.src || photo.thumbnail?.src} alt={`Aircraft ${index + 1}`} className="aircraft-photo" />
                                <a href={photo.link} target="_blank" rel="noopener noreferrer" className="sb-photo-credit">
                                    © {photo.photographer} <span>↗</span>
                                </a>
                            </div>
                        ))}
                    </div>
                ) : (
                    /* Fallback to Airline Logo */
                    logoUrl && (
                        <div className="sb-logo-container">
                            <img src={logoUrl} alt="Airline Logo" onError={(e) => (e.target.style.display = 'none')} />
                        </div>
                    )
                )}

                {/* Advanced Route Card (Dark Theme Symmetric Layout) */}
                <div className="sb-route-card">
                    <div className="sb-route-top">
                        <div className="sb-route-half left">
                            <div className="sb-airport-code">{depData.code}</div>
                            {depData.city && <div className="sb-airport-city">{depData.city}</div>}
                        </div>
                        <div className="sb-route-center">
                            <div className="route-plane-icon">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                    <path d="M21,16V14L13,9V3.5A1.5,1.5 0 0,0 11.5,2A1.5,1.5 0 0,0 10,3.5V9L2,14V16L10,13.5V19L8,20.5V22L11.5,21L15,22V20.5L13,19V13.5L21,16Z" />
                                </svg>
                            </div>
                        </div>
                        <div className="sb-route-half right">
                            <div className="sb-airport-code">{arrData.code}</div>
                            {arrData.city && <div className="sb-airport-city">{arrData.city}</div>}
                        </div>
                    </div>
                    {(dep || arr || (route && route.firstSeen)) && (
                        <div className="sb-route-bottom">
                            <div className="sb-route-time left">
                                <span className="time-label">ACTUAL DEP:</span>
                                <span className="time-val">
                                    {route?.firstSeen ? new Date(route.firstSeen * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'}
                                </span>
                            </div>
                            <div className="sb-route-time right" style={{ textAlign: 'right' }}>
                                <span className="time-label">ESTIMATED:</span>
                                <span className="time-val">TBD</span>
                            </div>
                        </div>
                    )}
                </div>

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
                <div className={`sb-section-title accordion ${openSections.spatial ? 'open' : ''}`} onClick={() => toggleSection('spatial')}>
                    {t('spatialData')}
                    <span className="chevron"></span>
                </div>
                {openSections.spatial && (
                    <div className="sb-section-content">
                        <DataRow label={t('altitude')} value={plane.onGround ? 'GROUND' : `${plane.altitude} m`} />
                        {plane.geoAltitude && (
                            <DataRow label={t('gpsAlt')} value={`${plane.geoAltitude} m`} />
                        )}
                        <DataRow label={t('speed')} value={`${Math.round(plane.velocity * 3.6)} km/h`} />
                        <DataRow label={t('heading')} value={`${Math.round(plane.heading)}°`} />
                        <DataRow label={t('vertRate')} value={formatVerticalRate(plane.vRate)} />
                        <DataRow label={t('position')} value={`${plane.lat.toFixed(4)}, ${plane.lng.toFixed(4)}`} />
                        <DataRow label={t('source')} value={posSourceMap[plane.positionSource] || 'Unknown'} />
                    </div>
                )}

                {/* Status */}
                <div className={`sb-section-title accordion ${openSections.status ? 'open' : ''}`} onClick={() => toggleSection('status')}>
                    {t('status')}
                    <span className="chevron"></span>
                </div>
                {openSections.status && (
                    <div className="sb-section-content">
                        <DataRow label={t('squawk')} value={plane.squawk || '--'} />
                        <DataRow
                            label={t('spiLabel')}
                            value={plane.spi ? '⚠️ ACTIVE' : 'Normal'}
                            valueClass={plane.spi ? 'spi-active' : ''}
                        />
                        <DataRow label={t('lastContact')} value={contactTime} />
                        <DataRow label={t('dataAge')} value={`${dataAge}s ago`} />
                    </div>
                )}

                {/* Nearest Airport */}
                {nearest && (
                    <>
                        <div className={`sb-section-title accordion ${openSections.nearest ? 'open' : ''}`} onClick={() => toggleSection('nearest')}>
                            {t('nearestAirport')}
                            <span className="chevron"></span>
                        </div>
                        {openSections.nearest && (
                            <div className="sb-section-content">
                                <DataRow label={t('airport')} value={`${nearest.airport.icao} - ${nearest.airport.name}`} />
                                <DataRow label={t('distance')} value={`${nearest.distance} km`} />
                            </div>
                        )}
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
