import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { dataManager } from '../services/dataManager';
import './MobilePlaneCard.css';

export default function MobilePlaneCard({ plane, icao24, metadata, route, onClose, onExpand }) {
    const [photoUrl, setPhotoUrl] = useState(null);
    const touchStartY = useRef(null);
    const cardRef = useRef(null);

    const callsign     = plane?.callsign || icao24 || '---';
    const typecode     = plane?.typecode || metadata?.typecode || '';
    const description  = metadata?.description || typecode || '---';
    const registration = metadata?.registration || plane?.registration || '';

    const dep = route?.departure?.airport?.iata || route?.departure?.iata || null;
    const arr = route?.arrival?.airport?.iata   || route?.arrival?.iata   || null;

    useEffect(() => {
        if (!icao24) return;
        dataManager.getPhotos(icao24, registration || undefined)
            .then(results => {
                const first = results?.[0];
                if (first) setPhotoUrl(first.thumbnail_large?.src || first.thumbnail?.src || null);
            })
            .catch(() => {});
    }, [icao24, registration]);

    // 往上滑 → 展開詳細；往下滑 → 關閉
    const handleTouchStart = (e) => {
        touchStartY.current = e.touches[0].clientY;
    };

    const handleTouchEnd = (e) => {
        if (touchStartY.current === null) return;
        const dy = touchStartY.current - e.changedTouches[0].clientY;
        if (dy > 40) onExpand();       // 上滑 40px → 展開
        if (dy < -40) onClose();       // 下滑 40px → 關閉
        touchStartY.current = null;
    };

    return (
        <div
            className="mpc-card"
            ref={cardRef}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
        >
            {/* Drag handle */}
            <div className="mpc-handle-bar" />

            {/* Full-width photo */}
            <div className="mpc-photo">
                {photoUrl
                    ? <img src={photoUrl} alt={callsign} />
                    : <div className="mpc-photo-placeholder">✈</div>
                }
            </div>

            {/* Info row */}
            <div className="mpc-row">
                <div className="mpc-info">
                    <div className="mpc-callsign">{callsign}</div>
                    <div className="mpc-type">{description}</div>
                    {(dep || arr) && (
                        <div className="mpc-route">
                            <span>{dep || '---'}</span>
                            <span className="mpc-route-arrow">→</span>
                            <span>{arr || '---'}</span>
                        </div>
                    )}
                </div>

                <button className="mpc-close" onClick={onClose} aria-label="關閉">
                    <X size={18} />
                </button>
            </div>
        </div>
    );
}
