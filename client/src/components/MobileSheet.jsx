import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { dataManager } from '../services/dataManager';
import './MobileSheet.css';

const PEEK_H = 88;   // just handle + stat bar
const MID_H  = 290;  // handle + photo + info row

export default function MobileSheet({ plane, icao24, metadata, route, onClose, onExpand }) {
    const [snap, setSnap]         = useState('mid');
    const [photoUrl, setPhotoUrl] = useState(null);
    const [dragging, setDragging] = useState(false);
    const [dragDy, setDragDy]     = useState(0);

    const touchStartY   = useRef(null);
    const currentSnapH  = snap === 'peek' ? PEEK_H : MID_H;

    /* ── Data ── */
    const callsign     = plane?.callsign    || icao24  || '---';
    const typecode     = plane?.typecode    || '';
    const description  = metadata?.description || typecode || '---';
    const registration = metadata?.registration || plane?.registration || '';

    const dep = route?.departure?.airport?.iata || route?.departure?.iata || null;
    const arr = route?.arrival?.airport?.iata   || route?.arrival?.iata   || null;

    const altFt  = !plane?.onGround && plane?.altitude != null
        ? `${Math.round(plane.altitude).toLocaleString()} ft`
        : plane?.onGround ? 'GND' : null;
    const speedKmh = plane?.velocity != null
        ? `${Math.round(plane.velocity * 3.6)} km/h`
        : null;

    /* ── Photo ── */
    useEffect(() => {
        if (!icao24) return;
        setPhotoUrl(null);
        dataManager.getPhotos(icao24, registration || undefined)
            .then(results => {
                const first = results?.[0];
                if (first) setPhotoUrl(first.thumbnail_large?.src || first.thumbnail?.src || null);
            })
            .catch(() => {});
    }, [icao24, registration]);

    /* ── Gesture ── */
    const handleTouchStart = (e) => {
        touchStartY.current = e.touches[0].clientY;
        setDragging(true);
        setDragDy(0);
    };

    const handleTouchMove = (e) => {
        if (touchStartY.current === null) return;
        const dy = e.touches[0].clientY - touchStartY.current; // positive = dragging down
        setDragDy(dy);
    };

    const handleTouchEnd = (e) => {
        if (touchStartY.current === null) return;
        const dy = touchStartY.current - e.changedTouches[0].clientY; // positive = swipe up

        setDragging(false);
        setDragDy(0);
        touchStartY.current = null;

        if (snap === 'peek') {
            if (dy > 40)  setSnap('mid');
            if (dy < -40) onClose();
        } else {
            // mid
            if (dy > 40)  onExpand();
            if (dy < -40) setSnap('peek');
        }
    };

    /* ── Render ── */
    // Live drag offset: clamp so card doesn't disappear or overshoot
    const liveOffset = dragging
        ? Math.max(-40, Math.min(dragDy, snap === 'peek' ? currentSnapH - 20 : 80))
        : 0;

    return (
        <div
            className={`msheet msheet--${snap}`}
            style={{
                height: currentSnapH,
                transform: `translateY(${liveOffset}px)`,
                transition: dragging ? 'none' : 'height 0.38s cubic-bezier(0.16,1,0.3,1), transform 0.38s cubic-bezier(0.16,1,0.3,1)',
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
        >
            {/* Drag handle */}
            <div className="msheet__handle" />

            {/* Photo — only in mid state */}
            {snap === 'mid' && (
                <div className="msheet__photo">
                    {photoUrl
                        ? <img src={photoUrl} alt={callsign} />
                        : <div className="msheet__photo-empty">✈</div>
                    }
                </div>
            )}

            {/* Info bar — always visible */}
            <div className="msheet__bar">
                <div className="msheet__left">
                    <span className="msheet__callsign">{callsign}</span>
                    {snap === 'peek' && (
                        <span className="msheet__type-peek">{description}</span>
                    )}
                    <div className="msheet__meta">
                        {(dep || arr) && (
                            <span className="msheet__route">
                                {dep || '---'}<span className="msheet__arrow"> → </span>{arr || '---'}
                            </span>
                        )}
                        {altFt   && <span className="msheet__stat">{altFt}</span>}
                        {speedKmh && <span className="msheet__stat">{speedKmh}</span>}
                    </div>
                </div>

                <button className="msheet__close" onClick={onClose} aria-label="關閉">
                    <X size={17} />
                </button>
            </div>
        </div>
    );
}
