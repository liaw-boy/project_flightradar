import React, { useState, useEffect } from 'react';
import { Layers, ChevronDown, ChevronUp } from 'lucide-react';
import { useI18n } from '../hooks/useI18n';
import './FilterPanel.css';

// [v3.0] Map tile layer definitions
// [2026-08] CartoDB's anonymous basemaps.cartocdn.com CDN now requires an API
// key — unauthenticated requests return a 256x256 "API KEY REQUIRED"
// placeholder tile instead of a real map. Light/Dark moved to Esri's
// key-free Canvas basemaps (World_Light_Gray_Base / World_Dark_Gray_Base) —
// genuinely distinct grayscale/dark cartography, not a CSS filter over a
// full-color tile, and same arcgisonline.com host already trusted/CSP-
// allowlisted for the Satellite layer below, so no CSP change needed.
// Street moved to CyclOSM (also key-free). Satellite/Terrain unaffected.
export const MAP_LAYERS = [
    {
        id: 'light',
        label: 'Light',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        attribution: '© Esri',
    },
    {
        id: 'dark',
        label: 'Dark',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        attribution: '© Esri',
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
        url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        attribution: '© OpenStreetMap contributors, © CyclOSM',
    },
    {
        id: 'terrain',
        label: 'Terrain',
        url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
        attribution: '© OpenTopoMap contributors',
    },
];

export default function FilterPanel({ filters, onFilterChange, mapLayer, onMapLayerChange, embedded }) {
    const { t } = useI18n();
    const [isLayersExpanded, setIsLayersExpanded] = useState(false);
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
                            className={`layer-btn ${(mapLayer || 'light') === l.id ? 'active' : ''}`}
                            onClick={() => onMapLayerChange(l.id)}
                            title={l.label}
                        >
                            {l.label}
                        </div>
                    ))}
                </div>
            </div>

        </div>
    );
}
