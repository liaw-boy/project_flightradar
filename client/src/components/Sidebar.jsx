import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, AlertTriangle, Plane as PlaneIcon, Map, Fingerprint, Activity, MapPin, ChevronLeft, ChevronRight, Share2, Check } from 'lucide-react';
import {
    getAirlineLogoUrl, getAirlineBannerUrl, getAirlineName, getCountryIso, getCategoryName,
    getNearestAirport, formatVerticalRate, getAirportDisplayData,
    formatLocalTime, ICAO_TO_IATA
} from '../utils/flightUtils';
import { useI18n } from '../hooks/useI18n';
import { logToServer, logger } from '../utils/logger';
import { dataManager } from '../services/dataManager';
import { flightDetailsCache } from '../services/flightDetailsCache';
import TimePlayer from './TimePlayer';
import MiniRouteMap from './SidebarMiniMap';
import { AltitudeChart, FlightProgressInline, FlightProgress } from './SidebarFlightInfo';
import './Sidebar.css';

function headingDir(h) {
    if (h == null) return '';
    const dirs = ['N','NE','E','SE','S','SW','W','NW'];
    return dirs[Math.round(h / 45) % 8];
}

function ShareButton({ icao24 }) {
    const [copied, setCopied] = useState(false);
    const handleShare = () => {
        const url = `${window.location.origin}${window.location.pathname}?icao=${icao24}`;
        navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }).catch(() => {
            prompt('複製此連結：', url);
        });
    };
    return (
        <button
            onClick={handleShare}
            title="分享追蹤連結"
            style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: copied ? '#22d3ee' : 'var(--color-text-dim, #64748b)',
                padding: '4px', display: 'flex', alignItems: 'center',
                transition: 'color 0.2s', borderRadius: '6px',
            }}
        >
            {copied ? <Check size={20} /> : <Share2 size={20} />}
        </button>
    );
}

// ─── Main Sidebar Component ────────────────────────────────────────────────────
export default function Sidebar({
    plane, icao24, metadata, route, trackPoints, playbackTime, onPlaybackChange,
    flightHistoryRef, onClose, trackMode, onToggleTrack
}) {
    const { t } = useI18n();
    const [openSections, setOpenSections] = useState({
        spatial: true, specs: true, status: false, nearest: false,
    });

    const toggleSection = (s) => setOpenSections(prev => ({ ...prev, [s]: !prev[s] }));

    // Swipe-down to close (mobile bottom drawer)
    const touchStartY = useRef(null);
    const handleTouchStart = (e) => { touchStartY.current = e.touches[0].clientY; };
    const handleTouchEnd = (e) => {
        if (touchStartY.current === null) return;
        const delta = e.changedTouches[0].clientY - touchStartY.current;
        touchStartY.current = null;
        if (delta > 80) onClose(); // swipe down ≥80px closes drawer
    };

    // [Phase 16] Ultimate Data Fusion Hook with Skeletons
    const [fusionData, setFusionData] = useState(null);
    const [isLoadingDetails, setIsLoadingDetails] = useState(true);

    useEffect(() => {
        let isMounted = true;
        setIsLoadingDetails(true);
        setFusionData(null);
        
        const callsignParam = (plane.callsign && plane.callsign.trim() && plane.callsign !== plane.icao24?.toUpperCase()) ? plane.callsign.trim() : 'N/A';
        const cached = flightDetailsCache.get(icao24);
        if (cached) {
            setFusionData(cached);
            setIsLoadingDetails(false);
            // re-fetch in background to keep cache fresh
            fetch(`/api/flight/complete-details/${icao24}/${callsignParam}`)
                .then(r => r.json()).then(data => { flightDetailsCache.set(icao24, data); }).catch(() => {});
            return () => { isMounted = false; };
        }

        fetch(`/api/flight/complete-details/${icao24}/${callsignParam}`)
            .then(res => res.json())
            .then(data => {
                if (isMounted) {
                    flightDetailsCache.set(icao24, data);
                    setFusionData(data);
                    setIsLoadingDetails(false);
                }
            })
            .catch(err => {
                logger.error('UI', `Fusion API error for ${icao24}: ${err.message}`);
                if (isMounted) setIsLoadingDetails(false);
            });
        return () => { isMounted = false; };
    }, [icao24, plane.callsign]);

    const aircraft = fusionData?.aircraft || {};
    // Guard: if the API returned a route with status "Arrived" but the plane is currently
    // airborne, the data belongs to the PREVIOUS flight (callsign was reused).
    // Discard it and show no route info so we don't mislead the user.
    const rawRoute = fusionData?.route || {};
    const isStaleArrivedRoute =
        rawRoute.flightStatus === 'Arrived' && !plane.onGround;
    const routeInfo = isStaleArrivedRoute ? {} : rawRoute;

    const displayRegistration = aircraft.registration || metadata?.registration || plane.registration || '--';
    const typecode = aircraft.type || metadata?.typecode || plane.typecode || '--';

    // [v12.5] P0 Fix: Information Anemia - Priority resolve names
    const _isKnown = v => v && v !== 'Unknown' && v !== 'unknown' && v !== '--';
    // model: prefer Mictronics full model name (e.g. "Boeing 777-35E(ER)") over type code
    const aircraftModel = (_isKnown(aircraft.model) && aircraft.model) ||
                          (_isKnown(aircraft.description) && aircraft.description) ||
                          (_isKnown(plane.description) && plane.description) ||
                          [aircraft.manufacturer, aircraft.type].filter(_isKnown).join(' ') ||
                          (metadata ? [metadata.manufacturerName, metadata.model].filter(_isKnown).join(' ') : '') ||
                          '';
    // operator: prefer Mictronics operator (actual owner) over callsign-derived airline
    const operatorName = (_isKnown(aircraft.operator) && aircraft.operator) ||
                         (aircraft.airline && _isKnown(aircraft.airline) ? aircraft.airline : null) ||
                         null;

    // ── Image Resolution: Planespotters (multiple) ──────
    const [photos, setPhotos] = useState([]);
    const [currentPhotoIdx, setCurrentPhotoIdx] = useState(0);
    const [isImageLoaded, setIsImageLoaded] = useState(false);
    const [isFetching, setIsFetching] = useState(false);
    const [prevPhotoUrl, setPrevPhotoUrl] = useState(''); // [v6.9] Backdrop mirror for zero-flicker

    // [v7.0] Fix double-fetch: use plane.registration immediately (available at open time),
    // NOT displayRegistration — that updates again when fusionData loads, causing a second
    // network round-trip and resetting isImageLoaded to false.
    const photoRegRef = useRef(null);
    useEffect(() => {
        // Only update the registration key when icao24 changes (new plane)
        photoRegRef.current = plane.registration && plane.registration !== 'N/A'
            ? plane.registration
            : null;
    }, [icao24]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        let active = true;
        setIsFetching(true);

        const reg = photoRegRef.current;
        dataManager.getPhotos(icao24, reg || undefined)
            .then(results => {
                if (!active) return;
                const formatted = (results || []).slice(0, 1).map(p => ({
                    url: p.thumbnail_large?.src || p.thumbnail?.src || p.link || null,
                    photographer: p.photographer || 'Planespotters.net'
                })).filter(h => h.url);
                setPhotos(formatted);
                setCurrentPhotoIdx(0);
                setIsImageLoaded(false);
                setIsFetching(false);
            })
            .catch(() => {
                if (active) setIsFetching(false);
            });
        return () => { active = false; };
    }, [icao24]); // [v7.0] Only re-fetch on new plane, not on displayRegistration change

    const nextPhoto = (e) => {
        e.stopPropagation();
        setIsImageLoaded(false); // [v6.6] Reset for seamless transition
        setCurrentPhotoIdx(prev => (prev + 1) % photos.length);
    };
    const prevPhoto = (e) => {
        e.stopPropagation();
        setIsImageLoaded(false); // [v6.6] Reset for seamless transition
        setCurrentPhotoIdx(prev => (prev - 1 + photos.length) % photos.length);
    };


    // [Phase 20] Aggressive Airport Resolution (Bypassing literal "N/A" truthy trap)
    const validDepIata = (routeInfo.origin_iata && routeInfo.origin_iata !== 'N/A') ? routeInfo.origin_iata : null;
    const validArrIata = (routeInfo.destination_iata && routeInfo.destination_iata !== 'N/A') ? routeInfo.destination_iata : null;
    // When isStaleArrivedRoute, routeInfo={} but rawRoute still has valid airport codes — use as fallback
    const rawDepIata = (rawRoute.origin_iata && rawRoute.origin_iata !== 'N/A') ? rawRoute.origin_iata : null;
    const rawArrIata = (rawRoute.destination_iata && rawRoute.destination_iata !== 'N/A') ? rawRoute.destination_iata : null;
    const depCode = validDepIata || routeInfo.origin_icao || rawDepIata || rawRoute.origin_icao || plane.origin || route?.departureAirport;
    const arrCode = validArrIata || routeInfo.destination_icao || rawArrIata || rawRoute.destination_icao || plane.destination || route?.arrivalAirport;

    // Airport Resolution for UI distance/times
    const [depInfo, setDepInfo] = useState(null);
    const [arrInfo, setArrInfo] = useState(null);

    useEffect(() => {
        if (depCode && depCode !== 'N/A') dataManager.getAirport(depCode).then(setDepInfo);
        else setDepInfo(null);
    }, [depCode]);

    useEffect(() => {
        if (arrCode && arrCode !== 'N/A') dataManager.getAirport(arrCode).then(setArrInfo);
        else setArrInfo(null);
    }, [arrCode]);

    // [Phase 16] Prioritize OSINT Dictionary Names over fallback data
    const depName = routeInfo.origin_name || rawRoute.origin_name || rawRoute.origin_city || (depInfo ? (depInfo.city || depInfo.name) : (depCode || '---'));
    const arrName = routeInfo.destination_name || rawRoute.destination_name || rawRoute.destination_city || (arrInfo ? (arrInfo.city || arrInfo.name) : (arrCode || '---'));
    
    // Fallback display code if available
    const displayDepCode = depInfo?.iata || validDepIata || routeInfo.origin_iata || depCode || 'N/A';
    const displayArrCode = arrInfo?.iata || validArrIata || routeInfo.destination_iata || arrCode || 'N/A';

    const depCity = routeInfo.origin_city || (depInfo?.city || '');
    const arrCity = routeInfo.destination_city || (arrInfo?.city || '');

    // Derive IATA flight number locally from ICAO_TO_IATA map (deterministic, no flicker)
    const icaoCallsign = plane.callsign || plane.icao24?.toUpperCase() || '---';
    const icaoPrefix   = icaoCallsign.replace(/\d.*$/, '').toUpperCase();
    const iataPrefix   = ICAO_TO_IATA[icaoPrefix];
    const flightNum    = icaoCallsign.replace(/^[A-Z]+/, '');
    const iataFlight   = iataPrefix ? `${iataPrefix}${flightNum}` : null;

    const logoUrl = getAirlineLogoUrl(plane.callsign);
    const bannerUrl = getAirlineBannerUrl(plane.callsign);
    const nowUnix = Math.floor(Date.now() / 1000);
    const dataAge = Math.max(0, nowUnix - (plane.lastContact || nowUnix));
    const contactTime = new Date((plane.lastContact || nowUnix) * 1000).toLocaleTimeString();
    const fr24Url = `https://www.flightradar24.com/${plane.callsign}`;
    const airlineName = getAirlineName(plane.callsign);
    const posSourceMap = { 0: 'ADS-B', 1: 'ASTERIX', 2: 'MLAT', 3: 'FLARM' };

    return (
        <div className="sidebar active" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
            <div className="sb-header">
                {(bannerUrl || logoUrl) && (
                    <div className="sb-header-watermark">
                        <img
                            src={bannerUrl || logoUrl}
                            alt=""
                            onError={(e) => {
                                if (e.target.src !== logoUrl && logoUrl) {
                                    e.target.src = logoUrl;
                                } else {
                                    e.target.style.display = 'none';
                                }
                            }}
                        />
                    </div>
                )}
                <div className="sb-header-main" style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>

                    <h2 className="sb-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {iataFlight || icaoCallsign}
                        {iataFlight && (
                            <span className="sb-iata-badge">{icaoCallsign}</span>
                        )}
                        {typecode && <span className="sb-badge">{typecode}</span>}
                    </h2>
                    <div className="sb-subtitle" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {logoUrl && <img src={logoUrl} className="sb-airline-logo-mini" alt="" onError={(e) => { e.target.style.display = 'none'; }} />}
                        {(aircraft.airline && aircraft.airline !== 'Unknown') ? aircraft.airline : (airlineName || '')}
                    </div>

                </div>
                <div className="sb-header-actions">
                    <ShareButton icao24={icao24} />
                    <div className="sb-close" onClick={onClose}><X size={20} /></div>
                </div>
            </div>

            <div className="sb-content">
                {plane.isEmergency && (
                    <div className="alert-box" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                        <AlertTriangle size={18} />
                        EMERGENCY SQUAWK: {plane.squawk}
                    </div>
                )}

                <div className="sb-photo-container">
                    {(() => {
                        // Priority 1: Real photo (Planespotters) — photographer's actual aircraft photo
                        const activePhoto = photos[currentPhotoIdx];

                        // Double-Buffered Image Display (Zero-Flicker)
                        if (photos.length > 0) {
                            const activePhoto = photos[currentPhotoIdx];
                            return (
                                <div 
                                    className="sb-photo-carousel"
                                    style={{ 
                                        backgroundImage: prevPhotoUrl ? `url(${prevPhotoUrl})` : 'none',
                                        backgroundSize: 'cover',
                                        backgroundPosition: 'center'
                                    }}
                                >
                                    {/* Layering: The image only fades in AFTER loading, staying transparent otherwise */}
                                    <img 
                                        key={activePhoto.url} 
                                        src={activePhoto.url} 
                                        alt={aircraftModel} 
                                        className={`aircraft-photo ${isImageLoaded ? 'fade-in' : 'loading-hidden'}`}
                                        onLoad={() => {
                                            setIsImageLoaded(true);
                                            setPrevPhotoUrl(activePhoto.url); // [v6.9] Update backdrop only on success
                                        }}
                                        onError={(e) => { e.target.style.display = 'none'; }}
                                    />

                                    {/* Loading indication (only if we have NOTHING to show yet) */}
                                    {(!isImageLoaded || isFetching) && !prevPhotoUrl && (
                                        <div className="sb-photo-loading-overlay">
                                            <PlaneIcon size={32} className="sb-photo-loading-icon-mini" />
                                        </div>
                                    )}

                                    {photos.length > 1 && (
                                        <>
                                            <button className="carousel-nav prev" onClick={prevPhoto} aria-label="Previous photo">
                                                <ChevronLeft size={20} />
                                            </button>
                                            <button className="carousel-nav next" onClick={nextPhoto} aria-label="Next photo">
                                                <ChevronRight size={20} />
                                            </button>
                                            <div className="carousel-counter">
                                                {currentPhotoIdx + 1} / {photos.length}
                                            </div>
                                            <div className="carousel-dots">
                                                {photos.map((_, i) => (
                                                    <div 
                                                        key={i} 
                                                        className={`dot ${i === currentPhotoIdx ? 'active' : ''}`}
                                                        onClick={(e) => { e.stopPropagation(); setCurrentPhotoIdx(i); }}
                                                    />
                                                ))}
                                            </div>
                                        </>
                                    )}
                                    
                                    <a href={activePhoto.url} target="_blank" rel="noopener noreferrer" className="sb-photo-credit">
                                        © {activePhoto.photographer} <span>↗</span>
                                    </a>
                                </div>
                            );
                        }

                        // Loading spinner while photo is still resolving
                        if (isLoadingDetails) {
                            return (
                                <div className="sb-photo-carousel sb-photo-loading">
                                    <PlaneIcon size={48} className="sb-photo-loading-icon" />
                                </div>
                            );
                        }

                        // Final Fallback: Placeholder
                        return (
                            <div className="sb-logo-placeholder">
                                <PlaneIcon size={64} className="sb-photo-placeholder-icon" />
                                <span className="sb-photo-placeholder-text">NO PHOTO AVAILABLE</span>
                            </div>
                        );



                    })()}
                </div>

                {/* ── Boarding Pass Route Card ── */}
                <div className="sb-boarding-pass">
                    <div className="bp-row">
                        {/* Origin */}
                        <div className="bp-endpoint bp-origin">
                            <span className="bp-flag" style={{ visibility: depInfo?.country ? 'visible' : 'hidden' }}>
                                {getCountryIso(depInfo?.country)
                                    ? <span className={`fi fi-${getCountryIso(depInfo.country)}`} />
                                    : null}
                            </span>
                            <div className={`bp-iata${(!displayDepCode || displayDepCode === 'N/A') ? ' bp-iata-na' : ''}`}>
                                {(!displayDepCode || displayDepCode === 'N/A') ? 'N/A' : displayDepCode}
                            </div>
                            {depName && depName !== depCode && depName !== '---' && (
                                <div className="bp-city">{depName}</div>
                            )}
                            <div className="bp-gate" style={{ visibility: (routeInfo.departure_terminal || routeInfo.departure_gate) ? 'visible' : 'hidden' }}>
                                {routeInfo.departure_terminal && <span>T{routeInfo.departure_terminal}</span>}
                                {routeInfo.departure_gate && <span> · {routeInfo.departure_gate}</span>}
                            </div>
                        </div>

                        {/* Center: inline progress */}
                        <div className="bp-arc-wrap">
                            {depInfo && arrInfo ? (
                                <FlightProgressInline plane={plane} depInfo={depInfo} arrInfo={arrInfo} />
                            ) : (
                                <PlaneIcon size={15} className="bp-arc-plane" style={{ transform: 'rotate(90deg)' }} />
                            )}
                        </div>

                        {/* Destination */}
                        <div className="bp-endpoint bp-dest">
                            <span className="bp-flag" style={{ visibility: arrInfo?.country ? 'visible' : 'hidden' }}>
                                {getCountryIso(arrInfo?.country)
                                    ? <span className={`fi fi-${getCountryIso(arrInfo.country)}`} />
                                    : null}
                            </span>
                            <div className={`bp-iata${(!displayArrCode || displayArrCode === '---' || displayArrCode === 'N/A') ? ' bp-iata-na' : ''}`}>
                                {(!displayArrCode || displayArrCode === '---' || displayArrCode === 'N/A') ? 'N/A' : displayArrCode}
                            </div>
                            {arrName && arrName !== arrCode && arrName !== '---' && (
                                <div className="bp-city">{arrName}</div>
                            )}
                            <div className="bp-gate" style={{ visibility: (routeInfo.arrival_terminal || routeInfo.arrival_gate) ? 'visible' : 'hidden', textAlign: 'right' }}>
                                {routeInfo.arrival_terminal && <span>T{routeInfo.arrival_terminal}</span>}
                                {routeInfo.arrival_gate && <span> · {routeInfo.arrival_gate}</span>}
                            </div>
                        </div>
                    </div>

                    {/* 4 Stats */}
                    <div className="sb-stats-grid">
                        <div className="stat-card">
                            <div className="stat-label">ALT</div>
                            <div className="stat-right">
                                <div className="stat-value">
                                    {plane.onGround ? 'GND' : (plane.altitude != null ? `${Math.round(plane.altitude).toLocaleString()}` : '---')}
                                </div>
                                {!plane.onGround && plane.altitude != null && <div className="stat-unit">ft</div>}
                            </div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">SPD</div>
                            <div className="stat-right">
                                <div className="stat-value">
                                    {plane.velocity != null ? Math.round(plane.velocity * 3.6) : '---'}
                                </div>
                                {plane.velocity != null && <div className="stat-unit">km/h</div>}
                            </div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">HDG</div>
                            <div className="stat-right">
                                <div className="stat-value stat-heading">
                                    {plane.heading != null ? `${Math.round(plane.heading)}°` : '---'}
                                </div>
                                {plane.heading != null && <div className="stat-unit">{headingDir(plane.heading)}</div>}
                            </div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">VSI</div>
                            <div className="stat-right">
                                <div className={`stat-value ${plane.vRate > 1.5 ? 'stat-climb' : plane.vRate < -1.5 ? 'stat-desc' : ''}`}>
                                    {plane.vRate != null
                                        ? `${plane.vRate > 1.5 ? '+' : plane.vRate < -1.5 ? '\u2212' : ''}${Math.round(Math.abs(plane.vRate) * 196.85)}`
                                        : '---'}
                                </div>
                                {plane.vRate != null && <div className="stat-unit">fpm</div>}
                            </div>
                        </div>
                    </div>

                    {depInfo && arrInfo && !isLoadingDetails && (
                        <MiniRouteMap depInfo={depInfo} arrInfo={arrInfo} />
                    )}
                </div>

                {/* [Phase 21] Ultimate Data Fusion: NOAA METAR Weather Card */}
                {(routeInfo.destination_weather || isLoadingDetails) && (
                    <div style={{ margin: '0 20px 20px 20px', borderRadius: '8px', overflow: 'hidden', background: 'var(--surface-hover)', border: '1px solid var(--border)', position: 'relative' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--surface-active)', borderBottom: '1px solid var(--border)' }}>
                            <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-accent)', letterSpacing: '0.8px' }}>
                                DESTINATION WEATHER ({arrCode || '...'})
                            </span>
                        </div>
                        <div style={{ padding: '12px' }}>
                            {isLoadingDetails ? (
                                <div className="sb-weather-skeleton">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                                        <div className="sb-skel-bar" style={{ width: '33%', height: '14px' }}></div>
                                        <div className="sb-skel-bar" style={{ width: '25%', height: '14px' }}></div>
                                    </div>
                                    <div className="sb-skel-bar" style={{ width: '100%', height: '11px', marginBottom: '8px' }}></div>
                                    <div className="sb-skel-bar" style={{ width: '83%', height: '11px' }}></div>
                                </div>
                            ) : (
                                <>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                                            <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 600 }}>WIND</span>
                                            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                                                {routeInfo.destination_weather.wdir != null ? `${routeInfo.destination_weather.wdir}°` : 'VRB'} / {routeInfo.destination_weather.wspd != null ? `${routeInfo.destination_weather.wspd}kts` : '--'}
                                            </span>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'right' }}>
                                            <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 600 }}>TEMP</span>
                                            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent-success)' }}>
                                                {routeInfo.destination_weather.temp != null ? `${routeInfo.destination_weather.temp}°C` : '--'}
                                            </span>
                                        </div>
                                    </div>
                                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }} title={routeInfo.destination_weather.rawOws}>
                                        {routeInfo.destination_weather.rawOws || 'NO RAW METAR DATA AVAILABLE'}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}

                <div className={`sb-section-title accordion ${openSections.spatial ? 'open' : ''}`} onClick={() => toggleSection('spatial')}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--color-text-primary)' }}>
                        <div className="sb-section-icon"><Map size={14} strokeWidth={2.5} /></div>
                        {t('spatialData')}
                    </span>
                    <span className={`chevron ${openSections.spatial ? 'open' : ''}`}></span>
                </div>
                {openSections.spatial && (
                    <div className="sb-section-content">
                        {/* Secondary info rows */}
                        <DataRow label={t('position')} value={plane.lat != null && plane.lng != null ? `${plane.lat.toFixed(4)}, ${plane.lng.toFixed(4)}` : 'N/A'} />
                        <DataRow label="Flight No." value={fusionData?.route?.flightNumber || plane.callsign || '---'} />
                        <DataRow label={t('source')} value={posSourceMap[plane.positionSource] || 'ADS-B'} />

                        {flightHistoryRef?.current && (
                            <AltitudeChart history={flightHistoryRef.current} icao24={icao24} />
                        )}
                    </div>
                )}
                
                <div className={`sb-section-title accordion ${openSections.specs ? 'open' : ''}`} onClick={() => toggleSection('specs')}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--color-text-primary)' }}>
                        <div className="sb-section-icon"><Fingerprint size={14} strokeWidth={2.5} /></div>
                        {t('flightIdentity')}
                    </span>
                    <span className={`chevron ${openSections.specs ? 'open' : ''}`}></span>
                </div>
                {openSections.specs && (
                    <div className="sb-section-content">
                        <DataRow label={t('icao24')} value={icao24.toUpperCase()} />
                        <DataRow label={t('registration')} value={displayRegistration} />
                        <DataRow label={t('type')} value={typecode} />
                        {aircraftModel && <DataRow label="Model" value={aircraftModel} />}
                        {operatorName && <DataRow label="Operator" value={operatorName} />}
                        <DataRow label={t('airline')} value={
                            (aircraft.airline && aircraft.airline !== 'Unknown') ? aircraft.airline : (airlineName || '--')
                        } />
                    </div>
                )}

                <div className={`sb-section-title accordion ${openSections.status ? 'open' : ''}`} onClick={() => toggleSection('status')}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--color-text-primary)' }}>
                        <div className="sb-section-icon"><Activity size={14} strokeWidth={2.5} /></div>
                        {t('status')}
                    </span>
                    <span className={`chevron ${openSections.status ? 'open' : ''}`}></span>
                </div>
                {openSections.status && (
                    <div className="sb-section-content">
                        <DataRow label={t('squawk')} value={plane.squawk || '--'} />
                        <DataRow label={t('lastContact')} value={contactTime} />
                        <DataRow label={t('dataAge')} value={`${dataAge}s`} />
                    </div>
                )}

                <a href={fr24Url} target="_blank" rel="noopener noreferrer" className="route-btn" onClick={() => logToServer(`FR24 track: ${plane.callsign}`, 'info')}>
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
