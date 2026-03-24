import React, { useState, useEffect, useRef } from 'react';
import { dataManager } from '../services/dataManager';
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

        Promise.all([
            dataManager.getPhotos(plane.icao24, plane.registration),
            dataManager.getRoute(plane.icao24, plane.callsign),
            fetch(`/api/flight/complete-details/${plane.icao24}/${callsignParam}`)
                .then(r => r.ok ? r.json() : null).catch(() => null)
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

    const depDisplay = depCode || '???';
    const arrDisplay = arrCode || '???';

    const depName = route?.depCity || depInfo?.city || depInfo?.name || '';
    const arrName = route?.arrCity || arrInfo?.city || arrInfo?.name || '';

    const style = {
        left: pos.x,
        top: pos.y - 10,
        transform: 'translate(-50%, -100%)'
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
                    <span className="hover-callsign">{plane.callsign || 'N/A'}</span>
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
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(90deg)', color: '#94a3b8' }}>
                                    <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 4s-2 1-3.5 2.5L7 8 .8 6.2c-.6-.2-.8.5-.4.9l5.9 5.9-2.6 2.1c-.4.3-.4.9 0 1.2l2 2c.3.4.9.4 1.2 0l2.1-2.6 5.9 5.9c.4.4 1.1.2.9-.4z"/>
                                </svg>
                            </div>
                            <div className="hover-route-node hover-route-node-right">
                                <span className="hover-iata">{arrDisplay}</span>
                                {arrName && <span className="hover-city">{arrName}</span>}
                            </div>
                        </div>
                    </div>
                )}

                <div className="hover-stats">
                    <span>{Math.round((plane.altitude || 0) * 3.28084).toLocaleString()} ft</span>
                    <span className="stats-divider">&bull;</span>
                    <span>{Math.round((plane.velocity || 0) * 1.94384)} kts</span>
                </div>
            </div>
        </div>
    );
}
