import React, { useState, useEffect } from 'react';
import {
    getAirlineLogoUrl,
    getAirlineName,
    getCountryFlag,
    getCategoryName,
    getNearestAirport,
    formatVerticalRate,
    getAirportDisplayData,
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

    const aircraftModel = metadata
        ? [metadata.manufacturerName, metadata.model].filter(Boolean).join(' ') || 'Unknown'
        : plane.aircraftType || 'Loading...';
    const typecode = metadata?.typecode || '';
    const registration = metadata?.registration || plane.registration || 'N/A';

    const depCode = route?.departureAirport || (route?.noData ? 'N/A' : null);
    const arrCode = route?.arrivalAirport || (route?.noData ? 'N/A' : null);

    const [depInfo, setDepInfo] = useState(null);
    const [arrInfo, setArrInfo] = useState(null);

    useEffect(() => {
        if (depCode && depCode !== 'N/A') getAirportDisplayData(depCode).then(setDepInfo);
        else setDepInfo(null);
    }, [depCode]);

    useEffect(() => {
        if (arrCode && arrCode !== 'N/A') getAirportDisplayData(arrCode).then(setArrInfo);
        else setArrInfo(null);
    }, [arrCode]);

    const depName = depInfo ? (depInfo.city || depInfo.name) : (depCode || '...');
    const arrName = arrInfo ? (arrInfo.city || arrInfo.name) : (arrCode || '...');

    const [photos, setPhotos] = useState([]);
    const [openSections, setOpenSections] = useState({
        spatial: true,
        specs: false,
        status: false,
        nearest: false
    });

    const toggleSection = (section) => {
        setOpenSections(prev => ({ ...prev, [section]: !prev[section] }));
    };

    useEffect(() => {
        let isMounted = true;
        setPhotos([]);
        const fetchPhotos = async () => {
            const results = [];
            if (icao24) {
                try {
                    const res = await fetch(`https://api.planespotters.net/pub/photos/hex/${icao24}`);
                    const data = await res.json();
                    if (data.photos) results.push(...data.photos);
                } catch (e) { }
            }
            if (registration && registration !== 'N/A' && results.length === 0) {
                try {
                    const res = await fetch(`https://api.planespotters.net/pub/photos/reg/${registration}`);
                    const data = await res.json();
                    if (data.photos) results.push(...data.photos);
                } catch (e) { }
            }
            if (isMounted) setPhotos(results);
        };
        fetchPhotos();
        return () => { isMounted = false; };
    }, [icao24, registration]);

    return (
        <div className="sidebar active">
            <div className="sb-header">
                <div className="sb-header-main">
                    <h2 className="sb-title">
                        {plane.callsign || 'UNKNOWN'}
                        {typecode && <span className="sb-badge">{typecode}</span>}
                    </h2>
                    <div className="sb-subtitle">
                        {airlineName || 'Unknown'} — {registration}
                    </div>
                </div>
                <div className="sb-close" onClick={onClose}>
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="3">
                        <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                </div>
            </div>

            <div className="sb-content">
                {plane.isEmergency && (
                    <div className="alert-box">🚨 EMERGENCY SQUAWK: {plane.squawk}</div>
                )}

                {photos.length > 0 ? (
                    <div className="sb-photo-carousel">
                        <img src={photos[0].thumbnail_large?.src || photos[0].thumbnail?.src} alt="Aircraft" className="aircraft-photo" />
                        <a href={photos[0].link} target="_blank" rel="noopener noreferrer" className="sb-photo-credit">
                            © {photos[0].photographer} <span>↗</span>
                        </a>
                    </div>
                ) : (
                    logoUrl && (
                        <div className="sb-logo-container">
                            <img src={logoUrl} alt="Airline Logo" />
                        </div>
                    )
                )}

                <div className="sb-route-card">
                    <div className="sb-route-display">
                        <div className="sb-route-node">
                            <div className="route-iata">{depInfo?.iata || depCode || '---'}</div>
                            <div className="route-city">{depName}</div>
                            {route?.isInferred && <div className="inferred-tag">{t('inferred')}</div>}
                        </div>

                        <div className="sb-route-center">
                            <div className="route-path-line"></div>
                            <div className="route-plane-icon">
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                    <path d="M21,16V14L13,9V3.5A1.5,1.5 0 0,0 11.5,2A1.5,1.5 0 0,0 10,3.5V9L2,14V16L10,13.5V19L8,20.5V22L11.5,21L15,22V20.5L13,19V13.5L21,16Z" />
                                </svg>
                            </div>
                        </div>

                        <div className="sb-route-node">
                            <div className="route-iata">{arrInfo?.iata || arrCode || '---'}</div>
                            <div className="route-city">{arrName}</div>
                        </div>
                    </div>

                    <div className="sb-route-bottom">
                        <div className="sb-route-time">
                            <div className="time-label">DEP (ACTUAL)</div>
                            <div className="time-val">{formatLocalTime(route?.firstSeen, depInfo?.timezone) || '--:--'}</div>
                        </div>
                        <div className="sb-route-time" style={{ textAlign: 'right' }}>
                            <div className="time-label">ARR (EST.)</div>
                            <div className="time-val">{formatLocalTime(route?.lastSeen, arrInfo?.timezone) || '--:--'}</div>
                        </div>
                    </div>
                </div>

                {/* Spatial Section */}
                <div className={`sb-section-title accordion ${openSections.spatial ? 'open' : ''}`} onClick={() => toggleSection('spatial')}>
                    <span>{t('spatialData')}</span>
                    <span className={`chevron ${openSections.spatial ? 'open' : ''}`}></span>
                </div>
                {openSections.spatial && (
                    <div className="sb-section-content">
                        <DataRow label={t('altitude')} value={plane.onGround ? 'GROUND' : `${plane.altitude} m`} />
                        {plane.geoAltitude && <DataRow label={t('gpsAlt')} value={`${plane.geoAltitude} m`} />}
                        <DataRow label={t('speed')} value={`${Math.round(plane.velocity * 3.6)} km/h`} />
                        <DataRow label={t('heading')} value={`${Math.round(plane.heading)}°`} />
                        <DataRow label={t('vertRate')} value={formatVerticalRate(plane.vRate)} />
                        <DataRow label={t('position')} value={`${plane.lat.toFixed(4)}, ${plane.lng.toFixed(4)}`} />
                        <DataRow label={t('source')} value={posSourceMap[plane.positionSource] || 'ADS-B'} />
                    </div>
                )}

                {/* Specs Section */}
                <div className={`sb-section-title accordion ${openSections.specs ? 'open' : ''}`} onClick={() => toggleSection('specs')}>
                    <span>{t('flightIdentity')}</span>
                    <span className={`chevron ${openSections.specs ? 'open' : ''}`}></span>
                </div>
                {openSections.specs && (
                    <div className="sb-section-content">
                        <DataRow label={t('icao24')} value={icao24.toUpperCase()} />
                        <DataRow label={t('registration')} value={registration} />
                        <DataRow label={t('type')} value={typecode ? `${typecode} — ${aircraftModel}` : aircraftModel} />
                        <DataRow label={t('airline')} value={airlineName || '--'} />
                        {metadata?.owner && <DataRow label="Owner" value={metadata.owner} />}
                        <DataRow label={t('country')} value={`${flag} ${plane.country || 'Unknown'}`} />
                    </div>
                )}

                {/* Status Section */}
                <div className={`sb-section-title accordion ${openSections.status ? 'open' : ''}`} onClick={() => toggleSection('status')}>
                    <span>{t('status')}</span>
                    <span className={`chevron ${openSections.status ? 'open' : ''}`}></span>
                </div>
                {openSections.status && (
                    <div className="sb-section-content">
                        <DataRow label={t('squawk')} value={plane.squawk || '--'} />
                        <DataRow label={t('spiLabel')} value={plane.spi ? t('spiActive') : t('spiNormal')} valueClass={plane.spi ? 'spi-active' : ''} />
                        <DataRow label={t('lastContact')} value={contactTime} />
                        <DataRow label={t('dataAge')} value={`${dataAge}s${t('dataAgeSuffix')}`} />
                    </div>
                )}

                {/* Nearest Airport */}
                {nearest && (
                    <>
                        <div className={`sb-section-title accordion ${openSections.nearest ? 'open' : ''}`} onClick={() => toggleSection('nearest')}>
                            <span>{t('nearestAirport')}</span>
                            <span className={`chevron ${openSections.nearest ? 'open' : ''}`}></span>
                        </div>
                        {openSections.nearest && (
                            <div className="sb-section-content">
                                <DataRow label={t('airport')} value={nearest.airport.icao} />
                                <DataRow label={t('distance')} value={`${nearest.distance} km`} />
                            </div>
                        )}
                    </>
                )}

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
