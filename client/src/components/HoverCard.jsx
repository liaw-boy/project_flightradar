import React, { useState, useEffect, useRef } from 'react';
import { Plane } from 'lucide-react';
import { dataManager } from '../services/dataManager';
import { flightDetailsCache } from '../services/flightDetailsCache';
import { ICAO_TO_IATA } from '../utils/flightUtils';
import './HoverCard.css';

/**
 * HoverCard - 飛機懸浮資訊框
 * @param {Object} plane - 飛機即時數據 (icao24, callsign, altitude, velocity, etc.)
 * @param {Object} pos - 位置 { x, y }
 */
export default function HoverCard({ plane, pos }) {
    const [photo, setPhoto] = useState(null);
    const [route, setRoute] = useState(null);
    const [depInfo, setDepInfo] = useState(null);
    const [arrInfo, setArrInfo] = useState(null);
    const prevIcaoRef = useRef(null);

    useEffect(() => {
        if (!plane) return;
        if (prevIcaoRef.current === plane.icao24) return;
        prevIcaoRef.current = plane.icao24;

        setRoute(null);
        setDepInfo(null);
        setArrInfo(null);

        const callsignParam = plane.callsign ? plane.callsign.trim() : 'UNKNOWN';
        const cachedFusion = flightDetailsCache.get(plane.icao24);

        Promise.all([
            dataManager.getPhotos(plane.icao24, plane.registration),
            dataManager.getRoute(plane.icao24, plane.callsign),
            cachedFusion
                ? Promise.resolve(cachedFusion)
                : fetch(`/api/flight/complete-details/${plane.icao24}/${callsignParam}`)
                    .then(r => r.ok ? r.json() : null)
                    .then(d => { if (d) flightDetailsCache.set(plane.icao24, d); return d; })
                    .catch(() => null)
        ]).then(([photos, routeData, fusionData]) => {
            if (photos && photos.length > 0) setPhoto(photos[0]);
            else setPhoto(null);

            // Merge: prefer fusion IATA codes, fall back to basic route ICAO codes
            const fusionRoute = fusionData?.route || {};
            const merged = {
                departureAirport: fusionRoute.origin_iata || fusionRoute.origin_icao || routeData?.departureAirport || null,
                arrivalAirport:   fusionRoute.destination_iata || fusionRoute.destination_icao || routeData?.arrivalAirport || null,
                depCity: fusionRoute.origin_city || fusionRoute.origin_name || null,
                arrCity: fusionRoute.destination_city || fusionRoute.destination_name || null,
            };
            setRoute(merged);

            // Still fetch airport details for city names if fusion didn't provide them
            if (merged.departureAirport && !merged.depCity)
                dataManager.getAirport(merged.departureAirport).then(setDepInfo).catch(() => {});
            if (merged.arrivalAirport && !merged.arrCity)
                dataManager.getAirport(merged.arrivalAirport).then(setArrInfo).catch(() => {});
        }).catch(() => {});

    }, [plane?.icao24, plane?.callsign, plane?.registration]);

    if (!plane) return null;

    const photoUrl = photo
        ? (photo.thumbnail_large?.src || photo.thumbnail?.src || photo.link || null)
        : null;

    const depCode = route?.departureAirport || null;
    const arrCode = route?.arrivalAirport || null;
    const hasRoute = depCode || arrCode;

    // 優先顯示 IATA 3 碼；若拿到的是 ICAO 4 碼則嘗試從 airport 查詢結果取 iata
    const toIata = (code, info) => {
        if (!code) return '???';
        if (code.length === 3) return code;                    // 已是 IATA
        if (code.length === 4 && info?.iata) return info.iata; // ICAO → IATA
        return code;
    };
    const depDisplay = toIata(depCode, depInfo);
    const arrDisplay = toIata(arrCode, arrInfo);

    const depName = route?.depCity || depInfo?.city || depInfo?.name || '';
    const arrName = route?.arrCity || arrInfo?.city || arrInfo?.name || '';

    const CARD_W = 240;
    const MARGIN = 8;
    const clampedX = Math.max(CARD_W / 2 + MARGIN, Math.min(pos.x, (window.innerWidth || 1440) - CARD_W / 2 - MARGIN));
    const above = pos.y > 280;
    const style = {
        left: clampedX,
        top: above ? pos.y - 10 : pos.y + 20,
        transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)'
    };

    return (
        <div className="hover-card" style={style}>
            <div className="hover-card-photo-wrapper">
                {photoUrl ? (
                    <>
                        <img src={photoUrl} alt="Aircraft" />
                        <div className="photo-credit">&copy; {photo.photographer || 'Network'}</div>
                    </>
                ) : (
                    <div className="photo-placeholder">{plane.callsign || plane.icao24}</div>
                )}
            </div>

            <div className="hover-card-content">
                <div className="hover-card-header">
                    {(() => {
                        const icao = plane.callsign || '';
                        const prefix = icao.replace(/\d.*$/, '').toUpperCase();
                        const iataP = ICAO_TO_IATA[prefix];
                        const num = icao.replace(/^[A-Z]+/, '');
                        const iata = iataP ? `${iataP}${num}` : null;
                        return <>
                            <span className="hover-callsign">{iata || icao || 'N/A'}</span>
                            {iata && <span className="hover-icao-badge">{icao}</span>}
                        </>;
                    })()}
                    <span className="hover-typecode">{plane.typecode || 'UNK'}</span>
                </div>

                {hasRoute && (
                    <div className="hover-route-block">
                        <div className="hover-route-hero">
                            <div className="hover-route-node">
                                <span className="hover-iata">{depDisplay}</span>
                                {depName && <span className="hover-city">{depName}</span>}
                            </div>
                            <div className="hover-route-center">
                                <Plane size={18} color="#00ff88" strokeWidth={1.5} />
                            </div>
                            <div className="hover-route-node hover-route-node-right">
                                <span className="hover-iata">{arrDisplay}</span>
                                {arrName && <span className="hover-city">{arrName}</span>}
                            </div>
                        </div>
                    </div>
                )}

                <div className="hover-stats">
                    <span>{plane.onGround ? 'GND' : `${Math.round((plane.altitude || 0) * 3.28084).toLocaleString()} ft`}</span>
                    <span className="stats-divider">&bull;</span>
                    <span>{Math.round((plane.velocity || 0) * 1.94384)} kts</span>
                </div>
            </div>
        </div>
    );
}
