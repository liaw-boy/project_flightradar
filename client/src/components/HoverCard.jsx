import React, { useState, useEffect, useRef } from 'react';
import { dataManager } from '../services/dataManager';
import './HoverCard.css';

/**
 * HoverCard - 精緻的飛機懸浮資訊框 (PlaneFinder 風格)
 * @param {Object} plane - 飛機即時數據 (icao24, callsign, altitude, velocity, etc.)
 * @param {Object} pos - 位置 { x, y }
 */
export default function HoverCard({ plane, pos }) {
    const [photo, setPhoto] = useState(null);
    const [route, setRoute] = useState(null);
    const prevIcaoRef = useRef(null);

    useEffect(() => {
        if (!plane) return;
        if (prevIcaoRef.current === plane.icao24) return;
        prevIcaoRef.current = plane.icao24;

        Promise.all([
            dataManager.getPhotos(plane.icao24, plane.registration),
            dataManager.getRoute(plane.icao24, plane.callsign)
        ]).then(([photos, routeData]) => {
            if (photos && photos.length > 0) setPhoto(photos[0]);
            else setPhoto(null);
            setRoute(routeData);
        }).catch(() => {});

    }, [plane?.icao24, plane?.callsign, plane?.registration]);

    if (!plane) return null;

    // Extract photo URL — planespotters returns { thumbnail_large: { src: "url" } }
    const photoUrl = photo
        ? (photo.thumbnail_large?.src || photo.thumbnail?.src || photo.link || null)
        : null;

    // Extract route display — backend returns ICAO codes as strings, not objects
    const depCode = route?.departureAirport || null;
    const arrCode = route?.arrivalAirport || null;
    const hasRoute = depCode || arrCode;

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
                    <div className="hover-route">
                        <div className="route-text">
                            {depCode || '???'} &rarr; {arrCode || '???'}
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
