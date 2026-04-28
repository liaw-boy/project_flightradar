import React, { useState, useEffect, useRef } from 'react';
import { Plane, X, ChevronRight } from 'lucide-react';
import { dataManager } from '../services/dataManager';
import { flightDetailsCache } from '../services/flightDetailsCache';
import { ICAO_TO_IATA, getAirlineLogoUrl } from '../utils/flightUtils';
import './ClickCard.css';

export default function ClickCard({ plane, pos, onClose, onOpenDetails }) {
    const [route, setRoute] = useState(null);
    const prevIcaoRef = useRef(null);

    useEffect(() => {
        if (!plane) return;
        if (prevIcaoRef.current === plane.icao24) return;
        prevIcaoRef.current = plane.icao24;
        setRoute(null);

        const callsignParam = plane.callsign ? plane.callsign.trim() : 'UNKNOWN';
        const cached = flightDetailsCache.get(plane.icao24);

        Promise.all([
            dataManager.getRoute(plane.icao24, plane.callsign),
            cached
                ? Promise.resolve(cached)
                : fetch(`/api/flight/complete-details/${plane.icao24}/${callsignParam}`)
                    .then(r => r.ok ? r.json() : null)
                    .then(d => { if (d) flightDetailsCache.set(plane.icao24, d); return d; })
                    .catch(() => null),
        ]).then(([basicRoute, fusionData]) => {
            const fr = fusionData?.route || {};
            setRoute({
                dep: fr.origin_iata || fr.origin_icao || basicRoute?.departureAirport || null,
                arr: fr.destination_iata || fr.destination_icao || basicRoute?.arrivalAirport || null,
                depCity: fr.origin_city || fr.origin_name || null,
                arrCity: fr.destination_city || fr.destination_name || null,
            });
        }).catch(() => {});
    }, [plane?.icao24, plane?.callsign]);

    if (!plane || !pos) return null;

    const CARD_W = 220;
    const MARGIN = 14;
    const ARROW_H = 8;
    const PLANE_ICON_R = 18;

    const vw = window.innerWidth;
    const clampedX = Math.max(CARD_W / 2 + MARGIN, Math.min(pos.x, vw - CARD_W / 2 - MARGIN));
    // Arrow X offset relative to card center (to point at actual plane position)
    const arrowOffsetX = pos.x - clampedX; // positive = arrow shifts right
    const above = pos.y > 250;

    const style = {
        left: clampedX,
        top: above ? pos.y - PLANE_ICON_R - ARROW_H : pos.y + PLANE_ICON_R + ARROW_H,
        transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
        '--arrow-offset': `calc(50% + ${arrowOffsetX}px)`,
    };

    const icao = plane.callsign || '';
    const prefix = icao.replace(/\d.*$/, '').toUpperCase();
    const iataP = ICAO_TO_IATA[prefix];
    const num = icao.replace(/^[A-Z]+/, '');
    const iataFlight = iataP ? `${iataP}${num}` : null;
    const logoUrl = prefix.length >= 2 ? getAirlineLogoUrl(plane.callsign) : null;

    const altFt = plane.onGround ? null : Math.round(plane.altitude || 0); // altitude already in feet
    const kts = Math.round((plane.velocity || 0) * 1.94384); // velocity in m/s → knots

    return (
        <div
            className={`click-card click-card--${above ? 'above' : 'below'}`}
            style={style}
        >
            <button className="click-card-close" onClick={onClose} title="關閉">
                <X size={11} strokeWidth={2.5} />
            </button>

            <div className="click-card-header">
                {logoUrl && (
                    <img
                        className="click-card-logo"
                        src={logoUrl}
                        alt=""
                        onError={e => { e.currentTarget.style.display = 'none'; }}
                    />
                )}
                <span className="click-card-flight">{iataFlight || icao || plane.icao24}</span>
                {iataFlight && icao && <span className="click-card-icao">{icao}</span>}
                {plane.typecode && <span className="click-card-type">{plane.typecode}</span>}
            </div>

            {route && (route.dep || route.arr) && (
                <div className="click-card-route">
                    <div className="click-card-port">
                        <span className="click-card-iata">{route.dep || '?'}</span>
                        {route.depCity && <span className="click-card-city">{route.depCity}</span>}
                    </div>
                    <Plane size={13} strokeWidth={1.5} className="click-card-arrow" />
                    <div className="click-card-port click-card-port--right">
                        <span className="click-card-iata">{route.arr || '?'}</span>
                        {route.arrCity && <span className="click-card-city">{route.arrCity}</span>}
                    </div>
                </div>
            )}

            <div className="click-card-stats">
                {plane.onGround
                    ? <span className="click-card-gnd">GND</span>
                    : altFt != null && <span>{altFt.toLocaleString()} ft</span>
                }
                {!plane.onGround && kts > 0 && (
                    <>
                        <span className="click-card-dot">·</span>
                        <span>{kts} kts</span>
                    </>
                )}
            </div>

            {onOpenDetails && (
                <button className="click-card-details" onClick={onOpenDetails}>
                    詳細資訊 <ChevronRight size={12} strokeWidth={2.5} />
                </button>
            )}
        </div>
    );
}
