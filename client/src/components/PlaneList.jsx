import React, { useState, useMemo } from 'react';
import { useI18n } from '../hooks/useI18n';
import { List, ChevronDown, ChevronUp } from 'lucide-react';
import './PlaneList.css';

export default function PlaneList({ planesDict, bounds, onSelectPlane, selectedIcao24, filters }) {
    const { t } = useI18n();
    const [isOpen, setIsOpen] = useState(true);
    const [sortBy, setSortBy] = useState('altitude');
    const [sortDesc, setSortDesc] = useState(true);

    const visiblePlanes = useMemo(() => {
        let planes = Object.values(planesDict);

        // [v3.1] Airline Fleet Focus Filter
        if (filters && filters.fleetFocus) {
            planes = planes.filter(p => p.callsign && p.callsign.startsWith(filters.fleetFocus));
        }

        // Filter by bounds if needed, or just show top N
        if (bounds) {
            planes = planes.filter(p => {
                const lat = parseFloat(p.lat);
                const lng = parseFloat(p.lng);
                if (lat < bounds.getSouth() || lat > bounds.getNorth() || lng < bounds.getWest() || lng > bounds.getEast()) {
                    return false;
                }
                return true;
            });
        }

        planes.sort((a, b) => {
            let valA = a[sortBy];
            let valB = b[sortBy];

            if (valA === 'GROUND') valA = 0;
            if (valB === 'GROUND') valB = 0;
            if (valA === 'N/A') valA = -1;
            if (valB === 'N/A') valB = -1;

            if (valA < valB) return sortDesc ? 1 : -1;
            if (valA > valB) return sortDesc ? -1 : 1;
            return 0;
        });

        // Limit to 50 planes for performance
        return planes.slice(0, 50);
    }, [planesDict, bounds, sortBy, sortDesc, filters?.fleetFocus]);

    const handleSort = (field) => {
        if (sortBy === field) {
            setSortDesc(!sortDesc);
        } else {
            setSortBy(field);
            setSortDesc(true);
        }
    };

    const getSortIndicator = (field) => {
        if (sortBy !== field) return '';
        return sortDesc ? <ChevronDown size={14} style={{ marginLeft: '2px', marginTop: '-2px' }} /> : <ChevronUp size={14} style={{ marginLeft: '2px', marginTop: '-2px' }} />;
    };

    return (
        <div className={`plane-list-panel ${isOpen ? 'open' : ''}`}>
            <div className="plane-list-toggle" onClick={() => setIsOpen(!isOpen)}>
                {isOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                <List size={16} style={{ marginLeft: '8px', marginRight: '6px' }} />
                {t('planeList') || 'AIRCRAFT LIST'}
            </div>

            <div className="plane-list-content">
                <div className="plane-list-header">
                    <div className="col-callsign" onClick={() => handleSort('callsign')}>{t('callsign') || 'CALLSIGN'}{getSortIndicator('callsign')}</div>
                    <div className="col-alt" onClick={() => handleSort('altitude')}>{t('altitude') || 'ALT'}{getSortIndicator('altitude')}</div>
                    <div className="col-spd" onClick={() => handleSort('velocity')}>{t('speed') || 'SPD'}{getSortIndicator('velocity')}</div>
                </div>

                <div className="plane-list-body">
                    {visiblePlanes.map(p => (
                        <div
                            key={p.icao24}
                            className={`plane-list-row ${selectedIcao24 === p.icao24 ? 'selected' : ''} ${p.isEmergency ? 'emergency' : ''}`}
                            onClick={() => onSelectPlane(p.icao24, p)}
                        >
                            <div className="col-callsign">
                                {p.isEmergency && <span className="emg-dot"></span>}
                                {p.callsign || p.icao24}
                            </div>
                            <div className="col-alt">
                                {p.onGround ? 'GND' : `${Math.round(p.altitude)}m`}
                            </div>
                            <div className="col-spd">
                                {(p.velocity == null || (!p.onGround && p.velocity < 0.5))
                                    ? '---'
                                    : `${Math.round(p.velocity * 3.6)}km/h`}
                            </div>
                        </div>
                    ))}
                    {visiblePlanes.length === 0 && (
                        <div className="plane-list-empty">{t('noPlanesInView') || 'No aircraft in current view'}</div>
                    )}
                </div>
            </div>
        </div>
    );
}
