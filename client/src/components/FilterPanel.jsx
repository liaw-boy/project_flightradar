import React, { useState } from 'react';
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

import { ICAO_TO_IATA } from '../utils/flightUtils';

export default function FilterPanel({ filters, onFilterChange, colorScheme, onColorSchemeChange, mapLayer, onMapLayerChange, embedded }) {
    const { t } = useI18n();
    const [isThemesExpanded, setIsThemesExpanded] = useState(false);
    const [isLayersExpanded, setIsLayersExpanded] = useState(false);

    const schemes = [
        { id: 'TACTICAL', label: t('themeTactical'), color: '#10b981' },
        { id: 'CLASSIC', label: t('themeClassic'), color: '#22d3ee' },
        { id: 'VIVID', label: t('themeVivid'), color: '#a3e635' },
        { id: 'MONO', label: t('themeMono'), color: '#fde047' },
        { id: 'HEATMAP', label: t('themeHeatmap'), color: '#dc2626' },
        { id: 'MIDNIGHT', label: t('themeMidnight'), color: '#1e3a8a' },
    ];

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

            {/* [v3.1] Airline Fleet Focus Mode */}
            <div className="filter-title" style={{ fontSize: '11px', opacity: 0.8, marginBottom: '8px' }}>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style={{ marginRight: '6px', transform: 'translateY(2px)' }}>
                    <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
                </svg>
                FLEET FOCUS
            </div>
            <select
                className="theme-select"
                value={filters.fleetFocus}
                onChange={(e) => onFilterChange('fleetFocus', e.target.value)}
                style={{ width: '100%', marginBottom: '15px' }}
            >
                <option value="">-- ALL FLEETS --</option>
                {Object.keys(ICAO_TO_IATA).sort().map(icao => (
                    <option key={icao} value={icao}>{icao} ({ICAO_TO_IATA[icao]})</option>
                ))}
            </select>

            <div className="stat-divider" style={{ margin: '0 0 15px 0' }} />

            {/* [v2.9.0] Map Layer Switcher */}
            <div
                className="filter-title collapsible-header"
                style={{ fontSize: '11px', opacity: 0.8, cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}
                onClick={() => setIsLayersExpanded(!isLayersExpanded)}
            >
                <div>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style={{ marginRight: '6px', transform: 'translateY(2px)' }}>
                        <path d="M12 2L2 7l10 5 10-5-10-5zm0 7.5l-10-5v2.5l10 5 10-5V9.5l-10 5zm0 5l-10-5v2.5l10 5 10-5V14.5l-10 5z" />
                    </svg>
                    MAP LAYER
                </div>
                <span className={`toggle-icon ${isLayersExpanded ? 'open' : ''}`}>▼</span>
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

            <div
                className="filter-title collapsible-header"
                style={{ fontSize: '11px', opacity: 0.8, cursor: 'pointer' }}
                onClick={() => setIsThemesExpanded(!isThemesExpanded)}
            >
                {t('themeLabel')}
                <span className={`toggle-icon ${isThemesExpanded ? 'open' : ''}`}>▼</span>
            </div>

            <div className={`theme-section ${isThemesExpanded ? 'expanded' : ''}`}>
                <div className="theme-grid">
                    {schemes.map((s) => (
                        <div
                            key={s.id}
                            className={`theme-swatch ${colorScheme === s.id ? 'active' : ''}`}
                            onClick={() => onColorSchemeChange(s.id)}
                            title={s.label}
                        >
                            <div className="swatch-color" style={{ background: s.color }} />
                            <span className="swatch-name">{s.label}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
