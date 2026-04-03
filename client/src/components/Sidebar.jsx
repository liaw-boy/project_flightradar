import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, AlertTriangle, Plane as PlaneIcon, Map, Fingerprint, Activity, MapPin, ChevronLeft, ChevronRight } from 'lucide-react';
import {
    getAirlineLogoUrl, getAirlineName, getCountryFlag, getCategoryName,
    getNearestAirport, formatVerticalRate, getAirportDisplayData,
    formatLocalTime
} from '../utils/flightUtils';
import { useI18n } from '../hooks/useI18n';
import { logToServer, logger } from '../utils/logger';
import { dataManager } from '../services/dataManager';
import TimePlayer from './TimePlayer';
import './Sidebar.css';

// ─── Haversine distance (km) ──────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Altitude Profile Mini-Chart (SVG) ────────────────────────────────────────
function AltitudeChart({ history, icao24 }) {
    const data = history?.[icao24];
    if (!data || data.length < 2) return null;

    const points = data.slice(-60);
    const altitudes = points.map((p, i) => ({ x: i, alt: p[3] ? 0 : (p[4] || 0) }));
    const trueMax = Math.max(...altitudes.map(p => p.alt));
    if (trueMax < 10) return null;

    const maxAlt = Math.max(trueMax, 1000);

    const W = 220;
    const H = 52;
    const xStep = W / Math.max(1, altitudes.length - 1);

    const pathD = altitudes.map((p, i) => {
        const x = i * xStep;
        const y = H - (p.alt / maxAlt) * (H - 4);
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const fillD = `${pathD} L ${W},${H} L 0,${H} Z`;

    return (
        <div style={{ margin: '14px 20px 4px 20px' }}>
            <div style={{ fontSize: 10, color: 'var(--color-text-dim)', marginBottom: 6, letterSpacing: 1, fontWeight: 700 }}>ALTITUDE PROFILE</div>
            <div style={{ position: 'relative', width: '100%', height: '52px', borderRadius: '6px', overflow: 'hidden', background: 'rgba(0,0,0,0.2)' }}>
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
                    <defs>
                        <linearGradient id="altGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="rgba(34,211,238,0.4)" />
                            <stop offset="100%" stopColor="rgba(34,211,238,0)" />
                        </linearGradient>
                    </defs>
                    <path d={fillD} fill="url(#altGrad)" />
                    <path d={pathD} fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeLinejoin="round" />
                    <text x="4" y="14" fill="rgba(255,255,255,0.7)" fontSize="10" fontFamily="JetBrains Mono, monospace" fontWeight="600">
                        {Math.round(maxAlt)}m
                    </text>
                </svg>
            </div>
        </div>
    );
}

// ─── Flight Progress Bar ───────────────────────────────────────────────────────
function FlightProgress({ plane, depInfo, arrInfo }) {
    const progress = useMemo(() => {
        if (!depInfo?.lat || !arrInfo?.lat || !plane?.lat || !plane?.lng) return null;
        const total = haversineKm(depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng);
        const done = haversineKm(depInfo.lat, depInfo.lng, plane.lat, plane.lng);
        const remaining = haversineKm(plane.lat, plane.lng, arrInfo.lat, arrInfo.lng);
        const rawPct = (done / total) * 100;
        const pct = Math.max(2, Math.min(100, Math.round(rawPct)));
        const etaMin = plane.velocity > 0 ? Math.round((remaining * 1000) / plane.velocity / 60) : null;
        return { pct, remaining: Math.round(remaining), etaMin };
    }, [plane, depInfo, arrInfo]);

    if (!progress) return null;
    const { pct, remaining, etaMin } = progress;
    const etaStr = etaMin !== null && etaMin >= 0 ? `${Math.floor(etaMin / 60)}h ${etaMin % 60}min` : '--';

    return (
        <div className="flight-progress" style={{ margin: '14px 20px', padding: '10px 14px', background: 'rgba(15, 23, 42, 0.4)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="fp-header" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '11px', fontWeight: 600, color: 'var(--color-text-dim)' }}>
                <span className="fp-pct" style={{ color: '#22d3ee' }}>{pct}% complete</span>
                <span className="fp-eta">ETA {etaStr} · {remaining}km</span>
            </div>
            <div className="fp-bar" style={{ position: 'relative', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px' }}>
                <div className="fp-fill" style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, #3b82f6, #22d3ee)', borderRadius: '3px' }}>
                    <PlaneIcon size={14} className="fp-plane-dot" style={{ position: 'absolute', right: '-7px', top: '-4px', color: '#fff', filter: 'drop-shadow(0 0 4px #22d3ee)', transform: 'rotate(90deg)' }} />
                </div>
            </div>
        </div>
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

    // [Phase 16] Ultimate Data Fusion Hook with Skeletons
    const [fusionData, setFusionData] = useState(null);
    const [isLoadingDetails, setIsLoadingDetails] = useState(true);

    useEffect(() => {
        let isMounted = true;
        setIsLoadingDetails(true);
        setFusionData(null);
        
        const callsignParam = plane.callsign ? plane.callsign.trim() : 'UNKNOWN';
        fetch(`/api/flight/complete-details/${icao24}/${callsignParam}`)
            .then(res => res.json())
            .then(data => {
                if (isMounted) {
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
    const routeInfo = fusionData?.route || {};

    const displayRegistration = aircraft.registration || metadata?.registration || plane.registration || '--';
    const typecode = aircraft.type || metadata?.typecode || plane.typecode || '--';
    
    // [v12.5] P0 Fix: Information Anemia - Priority resolve names
    const _isKnown = v => v && v !== 'Unknown' && v !== 'unknown' && v !== '--';
    const aircraftModel = (_isKnown(aircraft.description) && aircraft.description) ||
                          (_isKnown(plane.description) && plane.description) ||
                          [aircraft.manufacturer, aircraft.type].filter(_isKnown).join(' ') ||
                          (metadata ? [metadata.manufacturerName, metadata.model].filter(_isKnown).join(' ') : '') ||
                          '';

    // ── Image Resolution: Planespotters (multiple) ──────
    const [photos, setPhotos] = useState([]);
    const [currentPhotoIdx, setCurrentPhotoIdx] = useState(0);

    useEffect(() => {
        let active = true;
        setPhotos([]);
        setCurrentPhotoIdx(0);

        dataManager.getPhotos(icao24, displayRegistration !== '--' ? displayRegistration : undefined)
            .then(results => {
                if (!active || !results || results.length === 0) return;
                
                // Format photos for carousel
                const formatted = results.map(p => ({
                    url: p.thumbnail_large?.src || p.thumbnail?.src || p.link || null,
                    photographer: p.photographer || 'Planespotters.net'
                })).filter(h => h.url);
                
                setPhotos(formatted);
            })
            .catch(() => {});
        return () => { active = false; };
    }, [icao24, displayRegistration]);

    const nextPhoto = (e) => {
        e.stopPropagation();
        setCurrentPhotoIdx(prev => (prev + 1) % photos.length);
    };
    const prevPhoto = (e) => {
        e.stopPropagation();
        setCurrentPhotoIdx(prev => (prev - 1 + photos.length) % photos.length);
    };


    // [Phase 20] Aggressive Airport Resolution (Bypassing literal "N/A" truthy trap)
    const validDepIata = (routeInfo.origin_iata && routeInfo.origin_iata !== 'N/A') ? routeInfo.origin_iata : null;
    const validArrIata = (routeInfo.destination_iata && routeInfo.destination_iata !== 'N/A') ? routeInfo.destination_iata : null;
    const depCode = validDepIata || routeInfo.origin_icao || plane.origin || route?.departureAirport;
    const arrCode = validArrIata || routeInfo.destination_icao || plane.destination || route?.arrivalAirport;

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
    const depName = routeInfo.origin_name || (depInfo ? (depInfo.city || depInfo.name) : (depCode || '---'));
    const arrName = routeInfo.destination_name || (arrInfo ? (arrInfo.city || arrInfo.name) : (arrCode || '---'));
    
    // Fallback display code if available
    const displayDepCode = depInfo?.iata || validDepIata || routeInfo.origin_iata || depCode || 'N/A';
    const displayArrCode = arrInfo?.iata || validArrIata || routeInfo.destination_iata || arrCode || 'N/A';

    const depCity = routeInfo.origin_city || (depInfo?.city || '');
    const arrCity = routeInfo.destination_city || (arrInfo?.city || '');

    const logoUrl = getAirlineLogoUrl(plane.callsign);
    const nowUnix = Math.floor(Date.now() / 1000);
    const dataAge = Math.max(0, nowUnix - (plane.lastContact || nowUnix));
    const contactTime = new Date((plane.lastContact || nowUnix) * 1000).toLocaleTimeString();
    const fr24Url = `https://www.flightradar24.com/${plane.callsign}`;
    const airlineName = getAirlineName(plane.callsign);
    const posSourceMap = { 0: 'ADS-B', 1: 'ASTERIX', 2: 'MLAT', 3: 'FLARM' };

    return (
        <div className="sidebar active">
            <div className="sb-header">
                {logoUrl && (
                    <div className="sb-header-watermark">
                        <img src={logoUrl} alt="" />
                    </div>
                )}
                <div className="sb-header-main" style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>

                    <h2 className="sb-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {fusionData?.route?.flightNumber || plane.callsign || 'UNKNOWN'}
                        {typecode && <span className="sb-badge" style={{ marginLeft: '8px' }}>{typecode}</span>}
                    </h2>
                    <div className="sb-subtitle" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {logoUrl && <img src={logoUrl} alt="" className="sb-airline-logo-mini" onError={(e) => e.target.style.display = 'none'} />}
                        {(aircraft.airline && aircraft.airline !== 'Unknown') ? aircraft.airline : (airlineName || '')}
                    </div>

                </div>
                <div className="sb-header-actions">
                    <div className="sb-close" onClick={onClose}><X size={24} /></div>
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

                        if (activePhoto?.url) {
                            return (
                                <div className="sb-photo-carousel">
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
                                    <img 
                                        key={activePhoto.url} 
                                        src={activePhoto.url} 
                                        alt={aircraftModel} 
                                        className="aircraft-photo fade-in"
                                        onError={(e) => { e.target.style.display = 'none'; }}
                                    />
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

                {/* [Phase 16] Restored High-Fidelity Flight Progress View */}
                <div className="sb-route-card">
                    <div className="sb-route-hero">
                        <div className="sb-route-node">
                            <span className={`route-iata ${displayDepCode === 'N/A' || displayDepCode === '---' ? 'empty' : ''}`}>
                                {displayDepCode}
                            </span>
                        </div>

                        {/* [Phase 20] Perfectly centered directional indicator. Removed duplicate progress track. */}
                        <div className="sb-route-center">
                            <PlaneIcon
                                size={24}
                                className="text-slate-400"
                                style={{
                                    transform: 'rotate(90deg)',
                                    opacity: 0.8
                                }}
                            />
                        </div>

                        <div className="sb-route-node">
                            <span className={`route-iata ${displayArrCode === 'N/A' || displayArrCode === '---' ? 'empty' : ''}`}>
                                {displayArrCode}
                            </span>
                        </div>
                    </div>

                    <div className="sb-details-grid">
                        <div className="sb-airport-info">
                            <div className="sb-airport-meta" style={{ marginBottom: '4px' }}>
                                <span className="sb-tz-badge" style={{ background: 'rgba(34, 211, 238, 0.15)', color: 'var(--color-accent-cyan)' }}>DEP</span>
                                {depInfo?.timezone !== undefined && <span className="sb-tz-badge">UTC{depInfo.timezone >= 0 ? '+' : ''}{depInfo.timezone}</span>}
                            </div>
                            <div className={`sb-airport-name ${(!depInfo && !routeInfo.origin_name) ? 'dim' : ''}`} title={depName}>
                                {depName || (isLoadingDetails ? 'Loading...' : 'Origin Pending')}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--color-text-dim)', fontWeight: 600, marginTop: '2px' }}>{depCity}</div>
                        </div>

                        <div className="sb-airport-info" style={{ textAlign: 'right', alignItems: 'flex-end' }}>
                            <div className="sb-airport-meta" style={{ marginBottom: '4px' }}>
                                {arrInfo?.timezone !== undefined && <span className="sb-tz-badge">UTC{arrInfo.timezone >= 0 ? '+' : ''}{arrInfo.timezone}</span>}
                                <span className="sb-tz-badge" style={{ background: 'rgba(34, 255, 128, 0.15)', color: '#4ade80' }}>ARR</span>
                            </div>
                            <div className={`sb-airport-name ${(!arrInfo && !routeInfo.destination_name) ? 'dim' : ''}`} title={arrName}>
                                {arrName || (isLoadingDetails ? 'Loading...' : 'Destination Pending')}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--color-text-dim)', fontWeight: 600, marginTop: '2px' }}>{arrCity}</div>
                        </div>
                    </div>

                    <div className="sb-route-time-v2">
                        <div className={`time-item ${!routeInfo.departure_time ? 'dim' : ''}`}>
                            <span className="label">SCHED DEP</span>
                            <span className="val">{routeInfo.departure_time || '--:--'}</span>
                        </div>
                        <div className={`time-item ${!routeInfo.arrival_time ? 'dim' : ''}`} style={{ textAlign: 'right' }}>
                            <span className="label">SCHED ARR</span>
                            <span className="val" style={{ color: '#4ade80' }}>{routeInfo.arrival_time || '--:--'}</span>
                        </div>
                    </div>

                    {/* Flight Progress Bar only when both depInfo and arrInfo exist */}
                    {depInfo && arrInfo && !isLoadingDetails && (
                        <FlightProgress plane={plane} depInfo={depInfo} arrInfo={arrInfo} />
                    )}
                </div>

                {/* [Phase 21] Ultimate Data Fusion: NOAA METAR Weather Card */}
                {(routeInfo.destination_weather || isLoadingDetails) && (
                    <div style={{ margin: '0 20px 20px 20px', borderRadius: '8px', overflow: 'hidden', background: 'rgba(30,41,59,0.5)', border: '1px solid rgba(71,85,105,0.8)', position: 'relative' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(15,23,42,0.6)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                            <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-text-dim)', letterSpacing: '0.8px' }}>
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
                                            <span style={{ fontSize: 10, color: 'var(--color-text-dim)', fontWeight: 600 }}>WIND</span>
                                            <span style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>
                                                {routeInfo.destination_weather.wdir != null ? `${routeInfo.destination_weather.wdir}°` : 'VRB'} / {routeInfo.destination_weather.wspd != null ? `${routeInfo.destination_weather.wspd}kts` : '--'}
                                            </span>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'right' }}>
                                            <span style={{ fontSize: 10, color: 'var(--color-text-dim)', fontWeight: 600 }}>TEMP</span>
                                            <span style={{ fontSize: 14, fontWeight: 700, color: '#4ade80' }}>
                                                {routeInfo.destination_weather.temp != null ? `${routeInfo.destination_weather.temp}°C` : '--'}
                                            </span>
                                        </div>
                                    </div>
                                    <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#94a3b8', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }} title={routeInfo.destination_weather.rawOws}>
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
                        <DataRow label={t('altitude')} value={plane.onGround ? 'GROUND' : (plane.altitude != null ? `${plane.altitude} m` : 'N/A')} />
                        <DataRow label={t('speed')} value={plane.velocity != null ? `${Math.round(plane.velocity * 3.6)} km/h` : 'N/A'} />
                        <DataRow label={t('heading')} value={plane.heading != null ? `${Math.round(plane.heading)}°` : 'N/A'} />
                        <DataRow label={t('vertRate')} value={plane.vRate != null ? formatVerticalRate(plane.vRate) : 'N/A'} />
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
                        {aircraftModel && <DataRow label="Aircraft" value={aircraftModel} />}
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
