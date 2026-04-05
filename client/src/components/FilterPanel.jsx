import React, { useState, useEffect } from 'react';
import { Layers, ChevronDown, ChevronUp, Activity, ExternalLink } from 'lucide-react';
import { useI18n } from '../hooks/useI18n';
import './FilterPanel.css';

// [v2.9.0] Map tile layer definitions
export const MAP_LAYERS = [
    {
        id: 'dark',
        label: 'Dark',
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        attribution: '© OpenStreetMap contributors, © CartoDB',
    },
    {
        id: 'satellite',
        label: 'Satellite',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: '© Esri, DigitalGlobe',
    },
    {
        id: 'street',
        label: 'Street',
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        attribution: '© OpenStreetMap contributors, © CartoDB',
    },
    {
        id: 'terrain',
        label: 'Terrain',
        url: 'https://stamen-tiles-{s}.a.ssl.fastly.net/terrain/{z}/{x}/{y}{r}.jpg',
        attribution: 'Map tiles by Stamen Design, © OpenStreetMap contributors',
    },
];

export default function FilterPanel({ filters, onFilterChange, mapLayer, onMapLayerChange, embedded }) {
    const { t } = useI18n();
    const [isLayersExpanded, setIsLayersExpanded] = useState(false);
    const openMonitor = () => {
        // Points to our backend at port 3001
        const monitorUrl = `${window.location.origin}/monitor?token=dev`;
        // Open in a new tab next to the current one
        window.open(monitorUrl, '_blank');
    };


    return (
        <div className={`filter-panel ${embedded ? 'embedded' : ''}`}>
            <div className="filter-title">{t('filters')}</div>
            <label className="filter-option">
                <input
                    type="checkbox"
                    checked={filters.showGround}
                    onChange={(e) => onFilterChange('showGround', e.target.checked)}
                />
                <span>{t('showGround')}</span>
            </label>
            <label className="filter-option">
                <input
                    type="checkbox"
                    checked={filters.showEmergency}
                    onChange={(e) => onFilterChange('showEmergency', e.target.checked)}
                />
                <span>{t('showEmergency')}</span>
            </label>
            <label className="filter-option">
                <input
                    type="checkbox"
                    checked={filters.showLow}
                    onChange={(e) => onFilterChange('showLow', e.target.checked)}
                />
                <span>{t('showLow')}</span>
            </label>
            <label className="filter-option">
                <input
                    type="checkbox"
                    checked={filters.showAirports}
                    onChange={(e) => onFilterChange('showAirports', e.target.checked)}
                />
                <span>{t('showAirports')}</span>
            </label>

            <div className="stat-divider" style={{ margin: '15px 0' }} />

            {/* [v2.9.0] Map Layer Switcher */}
            <div
                className="filter-title collapsible-header"
                style={{ fontSize: '11px', opacity: 0.8, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                onClick={() => setIsLayersExpanded(!isLayersExpanded)}
            >
                <div style={{ display: 'flex', alignItems: 'center' }}>
                    <Layers size={14} style={{ marginRight: '6px' }} />
                    MAP LAYER
                </div>
                {isLayersExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </div>
            <div className={`theme-section ${isLayersExpanded ? 'expanded' : ''}`}>
                <div className="layer-grid">
                    {MAP_LAYERS.map((l) => (
                        <div
                            key={l.id}
                            className={`layer-btn ${(mapLayer || 'dark') === l.id ? 'active' : ''}`}
                            onClick={() => onMapLayerChange(l.id)}
                            title={l.label}
                        >
                            {l.label}
                        </div>
                    ))}
                </div>
            </div>

            <div className="stat-divider" style={{ margin: '15px 0' }} />

            {/* SYSTEM MONITOR */}
            <button className="sys-monitor-btn" onClick={openMonitor}>
                <Activity size={13} style={{ marginRight: '6px', flexShrink: 0 }} />
                系統監控
                <ExternalLink size={11} style={{ marginLeft: 'auto', opacity: 0.5 }} />
            </button>
        </div>
    );
}
