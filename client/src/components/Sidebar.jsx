import React, { useState, useEffect, useRef, useMemo } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, useMap } from 'react-leaflet';
import { X, AlertTriangle, Plane as PlaneIcon, Map, Fingerprint, Activity, MapPin, ChevronLeft, ChevronRight, Share2, Check } from 'lucide-react';
import {
    getAirlineLogoUrl, getAirlineName, getCountryIso, getCategoryName,
    getNearestAirport, formatVerticalRate, getAirportDisplayData,
    formatLocalTime, ICAO_TO_IATA
} from '../utils/flightUtils';
import { useI18n } from '../hooks/useI18n';
import { logToServer, logger } from '../utils/logger';
import { dataManager } from '../services/dataManager';
import { flightDetailsCache } from '../services/flightDetailsCache';
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
    const altitudes = points.map((p, i) => ({ x: i, alt: p[6] ? 0 : (p[3] || 0) }));
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
                        <linearGradient id={`altGrad-${icao24}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="rgba(34,211,238,0.4)" />
                            <stop offset="100%" stopColor="rgba(34,211,238,0)" />
                        </linearGradient>
                    </defs>
                    <path d={fillD} fill={`url(#altGrad-${icao24})`} />
                    <path d={pathD} fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeLinejoin="round" />
                    <text x="4" y="14" fill="rgba(255,255,255,0.7)" fontSize="10" fontFamily="JetBrains Mono, monospace" fontWeight="600">
                        {Math.round(maxAlt).toLocaleString()}ft
                    </text>
                </svg>
            </div>
        </div>
    );
}

// ─── Heading direction helper ─────────────────────────────────────────────────
function headingDir(h) {
    if (h == null) return '';
    const dirs = ['N','NE','E','SE','S','SW','W','NW'];
    return dirs[Math.round(h / 45) % 8];
}

// ─── Quadratic bezier arc (visual only, no geodesic math) ────────────────────
function curvePts(lat1, lng1, lat2, lng2, n = 40) {
    const dLat = lat2 - lat1;
    const dLng = lng2 - lng1;
    const dist = Math.sqrt(dLat * dLat + dLng * dLng);
    if (dist < 0.01) return [[lat1, lng1], [lat2, lng2]];
    // Control point: perpendicular to the line, lifted 20% of distance
    const lift = dist * 0.2;
    const ctrlLat = (lat1 + lat2) / 2 - (dLng / dist) * lift;
    const ctrlLng = (lng1 + lng2) / 2 + (dLat / dist) * lift;
    return Array.from({ length: n + 1 }, (_, i) => {
        const t = i / n, mt = 1 - t;
        return [
            mt * mt * lat1 + 2 * mt * t * ctrlLat + t * t * lat2,
            mt * mt * lng1 + 2 * mt * t * ctrlLng + t * t * lng2,
        ];
    });
}

// ─── Map bounds controller (react-leaflet inner component) ────────────────────
function MapBoundsCtrl({ bounds }) {
    const map = useMap();
    useEffect(() => {
        if (bounds) map.fitBounds(bounds, { padding: [20, 20], animate: false, maxZoom: 6 });
    }, [map, bounds]);
    return null;
}

// ─── Fix Leaflet size when container was off-screen during init ────────────────
function MapResizer() {
    const map = useMap();
    useEffect(() => {
        const t = setTimeout(() => map.invalidateSize(), 550);
        return () => clearTimeout(t);
    }, [map]);
    return null;
}

// ─── Theme hook ───────────────────────────────────────────────────────────────
function useIsDark() {
    const [isDark, setIsDark] = useState(() => document.documentElement.getAttribute('data-theme') !== 'light');
    useEffect(() => {
        const obs = new MutationObserver(() =>
            setIsDark(document.documentElement.getAttribute('data-theme') !== 'light')
        );
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => obs.disconnect();
    }, []);
    return isDark;
}

// ─── Mini Route Map (Leaflet real tiles + great-circle arc) ───────────────────
const MiniRouteMap = React.memo(function MiniRouteMap({ depInfo, arrInfo }) {
    const isDark = useIsDark();
    if (!depInfo?.lat || !depInfo?.lng || !arrInfo?.lat || !arrInfo?.lng) return null;

    const arcPoints = useMemo(() =>
        curvePts(depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng),
    [depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng]);

    const mapInit = useMemo(() => ({
        center: [(depInfo.lat + arrInfo.lat) / 2, (depInfo.lng + arrInfo.lng) / 2],
        zoom: 2,
    }), [depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng]);

    const mapBounds = useMemo(() => [
        [depInfo.lat, depInfo.lng],
        [arrInfo.lat, arrInfo.lng],
    ], [depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng]);

    const tileUrl = isDark
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

    if (!arcPoints.length) return null;

    return (
        <div style={{ margin: '0 12px 12px', borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--border)' }}>
            <MapContainer
                key={isDark ? 'dark' : 'light'}
                style={{ height: '145px', width: '100%' }}
                center={mapInit.center}
                zoom={mapInit.zoom}
                zoomControl={false}
                attributionControl={false}
                dragging={false}
                touchZoom={false}
                scrollWheelZoom={false}
                doubleClickZoom={false}
                boxZoom={false}
                keyboard={false}
            >
                <MapResizer />
                <MapBoundsCtrl bounds={mapBounds} />
                <TileLayer url={tileUrl} />
                {/* Great circle arc */}
                <Polyline
                    positions={arcPoints}
                    pathOptions={{ color: '#22d3ee', weight: 2, opacity: 0.75, dashArray: '6 4' }}
                />
                {/* Departure dot — use first arcPoint so lng matches the unwrapped arc */}
                <CircleMarker
                    center={arcPoints[0]}
                    radius={5}
                    pathOptions={{ color: '#22d3ee', fillColor: '#22d3ee', fillOpacity: 1, weight: 2 }}
                />
                {/* Arrival dot — use last arcPoint so lng matches the unwrapped arc */}
                <CircleMarker
                    center={arcPoints[arcPoints.length - 1]}
                    radius={5}
                    pathOptions={{ color: '#10b981', fillColor: '#10b981', fillOpacity: 1, weight: 2 }}
                />
            </MapContainer>
        </div>
    );
}, (prev, next) =>
    prev.depInfo?.lat === next.depInfo?.lat &&
    prev.depInfo?.lng === next.depInfo?.lng &&
    prev.arrInfo?.lat === next.arrInfo?.lat &&
    prev.arrInfo?.lng === next.arrInfo?.lng
);

// ─── Inline Progress (center column of boarding pass) ─────────────────────────
function FlightProgressInline({ plane, depInfo, arrInfo }) {
    const progress = useMemo(() => {
        if (!depInfo?.lat || !arrInfo?.lat || !plane?.lat || !plane?.lng) return null;
        const total = haversineKm(depInfo.lat, depInfo.lng, arrInfo.lat, arrInfo.lng);
        const done  = haversineKm(depInfo.lat, depInfo.lng, plane.lat, plane.lng);
        const pct   = Math.max(2, Math.min(98, Math.round((done / total) * 100)));
        return { pct };
    }, [plane, depInfo, arrInfo]);

    if (!progress) return <PlaneIcon size={15} className="bp-arc-plane" style={{ transform: 'rotate(90deg)' }} />;
    const { pct } = progress;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: '100%', paddingTop: 22 }}>
            <span style={{ fontSize: 11, fontWeight: 900, color: 'var(--accent)', letterSpacing: 0.5 }}>{pct}%</span>
            <div style={{ position: 'relative', width: '100%', height: 5, background: 'var(--border)', borderRadius: 3 }}>
                <div style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, var(--accent), var(--accent-2))', borderRadius: 3, boxShadow: '0 0 4px var(--accent)' }} />
                <div style={{ position: 'absolute', top: '50%', left: `${pct}%`, transform: 'translate(-50%, -50%)' }}>
                    <PlaneIcon size={22} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 5px var(--accent))' }} />
                </div>
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
        <div className="flight-progress" style={{ margin: '14px 20px', padding: '10px 14px', background: 'var(--surface-hover)', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <div className="fp-header" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '11px', fontWeight: 600, color: 'var(--text-3)' }}>
                <span className="fp-pct" style={{ color: 'var(--accent)' }}>{pct}% complete</span>
                <span className="fp-eta" style={{ color: 'var(--text-3)' }}>ETA {etaStr} · {remaining}km</span>
            </div>
            <div className="fp-bar" style={{ position: 'relative', height: '6px', background: 'var(--border)', borderRadius: '3px' }}>
                <div className="fp-fill" style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, var(--accent), var(--accent-2))', borderRadius: '3px' }}>
                    <PlaneIcon size={14} className="fp-plane-dot" style={{ position: 'absolute', right: '-7px', top: '-4px', color: 'var(--accent)', filter: 'var(--accent-glow)', transform: 'rotate(90deg)' }} />
                </div>
            </div>
        </div>
    );
}

// ─── Share Button ─────────────────────────────────────────────────────────────
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

    useEffect(() => {
        let active = true;
        
        // [v6.8] Do NOT clear current photos immediately to prevent "Black Flash"
        // Instead, we just start the new fetch in the background.
        setIsFetching(true); 

        dataManager.getPhotos(icao24, displayRegistration !== '--' ? displayRegistration : undefined)
            .then(results => {
                if (!active) return;
                
                // Format photos — only keep the first (best quality) photo
                const formatted = (results || []).slice(0, 1).map(p => ({
                    url: p.thumbnail_large?.src || p.thumbnail?.src || p.link || null,
                    photographer: p.photographer || 'Planespotters.net'
                })).filter(h => h.url);
                
                // [v6.8] BOMB FIX: Only update UI when we actually have the new set
                setPhotos(formatted);
                setCurrentPhotoIdx(0);
                setIsImageLoaded(false); 
                setIsFetching(false);
            })
            .catch(() => {
                if (active) setIsFetching(false);
            });
        return () => { active = false; };
    }, [icao24, displayRegistration]);

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
    const nowUnix = Math.floor(Date.now() / 1000);
    const dataAge = Math.max(0, nowUnix - (plane.lastContact || nowUnix));
    const contactTime = new Date((plane.lastContact || nowUnix) * 1000).toLocaleTimeString();
    const fr24Url = `https://www.flightradar24.com/${plane.callsign}`;
    const airlineName = getAirlineName(plane.callsign);
    const posSourceMap = { 0: 'ADS-B', 1: 'ASTERIX', 2: 'MLAT', 3: 'FLARM' };

    return (
        <div className="sidebar active" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
            <div className="sb-header">
                {logoUrl && (
                    <div className="sb-header-watermark">
                        <img src={logoUrl} alt="" />
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
