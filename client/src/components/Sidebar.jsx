import React, { useState, useEffect } from 'react';
import {
    getAirlineLogoUrl,
    getAirlineName,
    getCountryFlag,
    getCategoryName,
    getNearestAirport,
    formatVerticalRate,
    getAirportDisplayData,
    createPlaneSVG,
    AIRLINE_LOGOS,
    AIRPORTS,
    formatLocalTime
} from '../utils/flightUtils';
import { useI18n } from '../hooks/useI18n';
import { logToServer } from '../utils/logger';
import './Sidebar.css';


export default function Sidebar({ plane, icao24, metadata, route, onClose }) {
    if (!plane || !icao24) return null;

    const { t } = useI18n();
    const logoUrl = getAirlineLogoUrl(plane.callsign);
    const nowUnix = Math.floor(Date.now() / 1000);
    const dataAge = nowUnix - (plane.lastContact || nowUnix);
    const contactTime = new Date((plane.lastContact || nowUnix) * 1000).toLocaleTimeString();
    const fr24Url = `https://www.flightradar24.com/${plane.callsign}`;

    const handleFr24Click = () => {
        logToServer(`User tracking flight on FR24: ${plane.callsign}`, 'info', { callsign: plane.callsign, icao24 });
    };

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
    const depCode = route?.departureAirport || (route?.noData ? 'N/A' : null);
    const arrCode = route?.arrivalAirport || (route?.noData ? 'N/A' : null);

    const [depInfo, setDepInfo] = useState(null);
    const [arrInfo, setArrInfo] = useState(null);

    useEffect(() => {
        if (depCode && depCode !== 'N/A') {
            getAirportDisplayData(depCode).then(setDepInfo);
        } else {
            setDepInfo(null);
        }
    }, [depCode]);

    useEffect(() => {
        if (arrCode && arrCode !== 'N/A') {
            getAirportDisplayData(arrCode).then(setArrInfo);
        } else {
            setArrInfo(null);
        }
    }, [arrCode]);

    const depName = depInfo ? (depInfo.city || depInfo.name) : (depCode || '...');
    const arrName = arrInfo ? (arrInfo.city || arrInfo.name) : (arrCode || '...');

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
        if (!icao24 && !registration) return;

        const fetchPhotos = async () => {
            const results = [];

            // Try HEX first
            if (icao24) {
                try {
                    const res = await fetch(`https://api.planespotters.net/pub/photos/hex/${icao24}`);
                    const data = await res.json();
                    if (data.photos) results.push(...data.photos);
                } catch (e) { console.warn("HEX photo fetch failed"); }
            }

            // Try Registration as fallback or supplement
            if (registration && registration !== 'N/A') {
                try {
                    const res = await fetch(`https://api.planespotters.net/pub/photos/reg/${registration}`);
                    const data = await res.json();
                    if (data.photos) {
                        // Avoid duplicates and prioritize registration matches
                        const existingIds = new Set(results.map(p => p.id));
                        data.photos.forEach(p => {
                            if (!existingIds.has(p.id)) results.push(p);
                        });
                    }
                } catch (e) { console.warn("REG photo fetch failed"); }
            }

            if (isMounted) setPhotos(results);
        };

        fetchPhotos();
        return () => { isMounted = false; };
    }, [icao24, registration]);

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
                <div className={`sb-route-card ${route?.noData ? 'no-route' : ''}`}>
                    {!route?.noData ? (
                        <>
                            <div className="sb-route-display">
                                <div className="sb-route-left">
                                    <div className="route-iata">{depInfo?.iata || depCode || '---'}</div>
                                    <div className="route-city-container">
                                        <div className="route-city">{depName}</div>
                                        {route?.isInferred && <span className="inferred-badge">{t('inferred') || '推定'}</span>}
                                    </div>
                                </div>
                                <div className="sb-route-center">
                                    <div className="route-path-line"></div>
                                    <div className="route-plane-icon">
                                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                            <path d="M22,12 L18,8 L15,8 L16,11 L6,11 L3,6 L1,6 L4,12 L1,18 L3,18 L6,13 L16,13 L15,16 L18,16 L22,12 Z" />
                                        </svg>
                                    </div>
                                </div>
                                <div className="sb-route-right">
                                    <div className="route-iata">{arrInfo?.iata || arrCode || '---'}</div>
                                    <div className="route-city-container">
                                        <div className="route-city">{arrName}</div>
                                    </div>
                                </div>
                            </div>
                            {(route?.firstSeen || route?.lastSeen) && (
                                <div className="sb-route-bottom">
                                    <div className="sb-route-time left">
                                        <span className="time-label">ACTUAL DEP:</span>
                                        <span className="time-val">
                                            {formatLocalTime(route?.firstSeen, depInfo?.timezone)}
                                        </span>
                                    </div>
                                    <div className="sb-route-time right">
                                        <span className="time-label">ESTIMATED:</span>
                                        <span className="time-val">
                                            {formatLocalTime(route?.lastSeen, arrInfo?.timezone)}
                                        </span>
                                    </div>
                                </div>
                            )}
                        </>
                    ) : (
                        /* Graceful Degradation: Airline-only display */
                        <div className="sb-route-fallback">
                            <div className="fallback-airline">
                                <span className="airline-name">{airlineName || t('unknownAirline')}</span>
                                <span className="no-data-text"> — {t('routeNotPublished') || '航線未公開'}</span>
                            </div>
                            <div className="fallback-hint">{t('spatialInferenceFailed') || '系統解析中或為私人航班'}</div>
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
                            value={plane.spi ? t('spiActive') : t('spiNormal')}
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
                                <DataRow label={t('airport')} value={`${nearest.airport.icao} - ${t('airportName', nearest.airport.icao) || nearest.airport.name}`} />
                                <DataRow label={t('distance')} value={`${nearest.distance} km`} />
                            </div>
                        )}
                    </>
                )}

                {/* FR24 連結 */}
                <a href={fr24Url} target="_blank" rel="noopener noreferrer" className="route-btn" onClick={handleFr24Click}>
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
