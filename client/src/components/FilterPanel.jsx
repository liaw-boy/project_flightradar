import React from 'react';
import './FilterPanel.css';

export default function FilterPanel({ filters, onFilterChange }) {
    return (
        <div className="filter-panel">
            <div className="filter-title">🎛️ FILTERS</div>
            <label className="filter-option">
                <input
                    type="checkbox"
                    checked={filters.showGround}
                    onChange={(e) => onFilterChange('showGround', e.target.checked)}
                />
                <span>Show Ground</span>
            </label>
            <label className="filter-option">
                <input
                    type="checkbox"
                    checked={filters.showEmergency}
                    onChange={(e) => onFilterChange('showEmergency', e.target.checked)}
                />
                <span>Show Emergency</span>
            </label>
            <label className="filter-option">
                <input
                    type="checkbox"
                    checked={filters.showLow}
                    onChange={(e) => onFilterChange('showLow', e.target.checked)}
                />
                <span>Show Low Alt (&lt;1500m)</span>
            </label>
        </div>
    );
}
