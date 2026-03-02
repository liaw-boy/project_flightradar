import React, { useState } from 'react';
import { useI18n } from '../hooks/useI18n';
import './FilterPanel.css';

export default function FilterPanel({ filters, onFilterChange, colorScheme, onColorSchemeChange }) {
    const { t } = useI18n();
    const [isThemesExpanded, setIsThemesExpanded] = useState(false);

    const schemes = [
        { id: 'TACTICAL', label: t('themeTactical'), color: '#10b981' },
        { id: 'CLASSIC', label: t('themeClassic'), color: '#22d3ee' },
        { id: 'VIVID', label: t('themeVivid'), color: '#a3e635' },
        { id: 'MONO', label: t('themeMono'), color: '#fde047' },
        { id: 'HEATMAP', label: t('themeHeatmap'), color: '#dc2626' },
        { id: 'MIDNIGHT', label: t('themeMidnight'), color: '#1e3a8a' },
    ];

    return (
        <div className="filter-panel">
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
