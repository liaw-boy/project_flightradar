import React from 'react';
import { useI18n } from '../hooks/useI18n';
import './FilterPanel.css';

export default function FilterPanel({ filters, onFilterChange }) {
    const { t } = useI18n();

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
        </div>
    );
}
