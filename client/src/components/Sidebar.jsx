import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, AlertTriangle, Plane as PlaneIcon, Map, Fingerprint, Activity, MapPin } from 'lucide-react';
import {
    getAirlineLogoUrl, getAirlineName, getCountryFlag, getCategoryName,
    getNearestAirport, formatVerticalRate, getAirportDisplayData,
    formatLocalTime
} from '../utils/flightUtils';
import { useI18n } from '../hooks/useI18n';
import { logToServer } from '../utils/logger';
import { dataManager } from '../services/dataManager';
import TimePlayer from './TimePlayer';
import './Sidebar.css';

// ─── Haversine distance (km) ──────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
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
    if (trueMax < 10) return null; // Hide chart if plane never left the ground

    const maxAlt = Math.max(trueMax, 1000);

    const W = 220;
    const H = 52;
    const xStep = W / Math.max(1, altitudes.length - 1);

    // Build SVG path
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
        if (!depInfo?.lat || !arrInfo?.lat || !plane?.lat) return null;
        const total = haversineKm(depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng);
        const done = haversineKm(depInfo.lat, depInfo.lng, plane.lat, plane.lng);
        const remaining = haversineKm(plane.lat, plane.lng, arrInfo.lat, arrInfo.lng);
        const pct = Math.min(100, Math.round((done / total) * 100));
        const etaMin = plane.velocity > 0 ? Math.round((remaining * 1000) / plane.velocity / 60) : null;
        return { pct, remaining: Math.round(remaining), etaMin };
    }, [plane, depInfo, arrInfo]);

    if (!progress) return null;
    const { pct, remaining, etaMin } = progress;
    const etaStr = etaMin !== null ? `${Math.floor(etaMin / 60)}h ${etaMin % 60}min` : '--';

    return (
        <div className="flight-progress">
            <div className="fp-header">
                <span className="fp-pct">{pct}% complete</span>
                <span className="fp-eta">ETA {etaStr} · {remaining}km</span>
            </div>
            <div className="fp-bar">
                <div className="fp-fill" style={{ width: `${pct}%` }}>
                    <div className="fp-plane-dot" />
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
    // === HOOKS FIRST — React Rules of Hooks 要求所有 hook 在任何 early return 之前 ===
    const { t } = useI18n();
    const [depInfo, setDepInfo] = useState(null);
    const [arrInfo, setArrInfo] = useState(null);
    const [photos, setPhotos] = useState([]);
    const [openSections, setOpenSections] = useState({
        spatial: true, specs: false, status: false, nearest: false,
    });

    // 這些 derived values 被 useEffect 的 dependency array 使用，必須在 effect 前宣告
    const registration = metadata?.registration || plane?.registration || 'N/A';
    const depCode = route?.departureAirport || (route?.noData ? 'N/A' : null);
    const arrCode = route?.arrivalAirport || (route?.noData ? 'N/A' : null);

    useEffect(() => {
        if (depCode && depCode !== 'N/A') dataManager.getAirport(depCode).then(setDepInfo);
        else setDepInfo(null);
    }, [depCode]);

    useEffect(() => {
        if (arrCode && arrCode !== 'N/A') dataManager.getAirport(arrCode).then(setArrInfo);
        else setArrInfo(null);
    }, [arrCode]);

    useEffect(() => {
        let isMounted = true;
        setPhotos([]);
        const fetchPhotos = async () => {
            const results = await dataManager.getPhotos(icao24, registration);
            if (isMounted) setPhotos(results);
        };
        fetchPhotos();
        return () => { isMounted = false; };
    }, [icao24, registration]);

    // Early return — 放在所有 hook 之後
    if (!plane || !icao24) return null;

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

    const aircraftModel = metadata
        ? [metadata.manufacturerName, metadata.model].filter(Boolean).join(' ') || 'Unknown'
        : plane.aircraftType || 'Loading...';
    const typecode = metadata?.typecode || '';

    const toggleSection = (s) => setOpenSections(prev => ({ ...prev, [s]: !prev[s] }));

    const depName = depInfo ? (depInfo.city || depInfo.name) : (depCode || '...');
    const arrName = arrInfo ? (arrInfo.city || arrInfo.name) : (arrCode || '...');

    return (
        <div className="sidebar active">
            <div className="sb-header">
                <div className="sb-header-main">
                    <h2 className="sb-title">
                        {plane.callsign || 'UNKNOWN'}
                        {typecode && <span className="sb-badge">{typecode}</span>}
                    </h2>
                    <div className="sb-subtitle">{airlineName || 'Unknown'} — {registration}</div>
                </div>
                <div className="sb-header-actions">
                    <div className="sb-close" onClick={onClose}>
                        <X size={24} />
                    </div>
                </div>
            </div>

            <div className="sb-content">
                {plane.isEmergency && (
                    <div className="alert-box" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                        <AlertTriangle size={18} />
                        EMERGENCY SQUAWK: {plane.squawk}
                    </div>
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
                                <PlaneIcon size={18} />
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

                    {/* [v2.9.0] Flight Progress Bar */}
                    <FlightProgress plane={plane} depInfo={depInfo} arrInfo={arrInfo} />

                    {/* [v3.1] TimePlayer - Historical Playback integrated into Sidebar */}
                    {trackPoints && trackPoints.length >= 2 && (
                        <div style={{ padding: '0 20px 15px 20px' }}>
                            <div style={{ fontSize: 10, color: 'var(--color-text-dim)', marginBottom: 8, letterSpacing: 1, fontWeight: 700 }}>HISTORICAL REPLAY</div>
                            <TimePlayer
                                trackPoints={trackPoints}
                                onPlaybackChange={onPlaybackChange}
                                mode="sidebar-mode"
                            />
                        </div>
                    )}
                </div>

                {/* Spatial Section */}
                <div className={`sb-section-title accordion ${openSections.spatial ? 'open' : ''}`} onClick={() => toggleSection('spatial')}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--color-text-primary)' }}>
                        <div className="sb-section-icon"><Map size={14} strokeWidth={2.5} /></div>
                        {t('spatialData')}
                    </span>
                    <span className={`chevron ${openSections.spatial ? 'open' : ''}`}></span>
                </div>
                {openSections.spatial && (
                    <div className="sb-section-content">
                        <DataRow label={t('altitude')} value={plane.onGround ? 'GROUND' : `${plane.altitude} m`} />
                        {plane.geoAltitude && <DataRow label={t('gpsAlt')} value={`${plane.geoAltitude} m`} />}
                        <DataRow label={t('speed')} value={`${Math.round(plane.velocity * 3.6)} km/h`} />
                        <DataRow label={t('heading')} value={`${Math.round(plane.heading)}°`} />
                        <DataRow label={t('vertRate')} value={formatVerticalRate(plane.vRate)} />
                        <DataRow label={t('position')} value={plane.lat != null ? `${plane.lat.toFixed(4)}, ${plane.lng.toFixed(4)}` : 'N/A'} />
                        <DataRow label={t('source')} value={posSourceMap[plane.positionSource] || 'ADS-B'} />
                        {/* [v2.9.0] Altitude Profile Chart */}
                        {flightHistoryRef?.current && (
                            <AltitudeChart history={flightHistoryRef.current} icao24={icao24} />
                        )}
                    </div>
                )}

                {/* Specs Section */}
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
                        <DataRow label={t('registration')} value={registration} />
                        <DataRow label={t('type')} value={typecode ? `${typecode} — ${aircraftModel}` : aircraftModel} />
                        <DataRow label={t('airline')} value={airlineName || '--'} />
                        {metadata?.owner && <DataRow label="Owner" value={metadata.owner} />}
                        <DataRow label={t('country')} value={`${flag} ${plane.country || 'Unknown'}`} />
                    </div>
                )}

                {/* Status Section */}
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
                        <DataRow label={t('spiLabel')} value={plane.spi ? t('spiActive') : t('spiNormal')} valueClass={plane.spi ? 'spi-active' : ''} />
                        <DataRow label={t('lastContact')} value={contactTime} />
                        <DataRow label={t('dataAge')} value={`${dataAge}s${t('dataAgeSuffix')}`} />
                    </div>
                )}

                {/* Nearest Airport */}
                {nearest && (
                    <>
                        <div className={`sb-section-title accordion ${openSections.nearest ? 'open' : ''}`} onClick={() => toggleSection('nearest')}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--color-text-primary)' }}>
                                <div className="sb-section-icon"><MapPin size={14} strokeWidth={2.5} /></div>
                                {t('nearestAirport')}
                            </span>
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
