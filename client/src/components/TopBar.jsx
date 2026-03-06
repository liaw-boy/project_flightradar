import React, { useState, useEffect } from 'react';
import { useI18n } from '../hooks/useI18n';
import SearchBar from './SearchBar';
import FilterPanel from './FilterPanel';
import './TopBar.css';

export default function TopBar({
    planeCount,
    airCount,
    groundCount,
    apiStatus,
    apiStatusClass,
    planesDict,
    onSearchSelect,
    filters,
    onFilterChange,
    colorScheme,
    onColorSchemeChange,
    mapLayer,
    onMapLayerChange
}) {
    const { t, lang, toggleLang } = useI18n();
    const [time, setTime] = useState('--:--:--');
    const [showSettings, setShowSettings] = useState(false);

    useEffect(() => {
        const interval = setInterval(() => {
            setTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="top-bar">
            {/* Left: Branding & Core Stats */}
            <div className="top-bar-left">
                <div className="brand-logo">
                    <div className="live-dot" />
                    <h2>AEROSTRAT <span className="brand-suffix">RADAR</span></h2>
                    <span className="brand-version">v3.1.0</span>
                </div>

                <div className="top-stat-pill">
                    <span className="ts-label">{t('sysTime')}</span>
                    <span className="ts-value">{time}</span>
                </div>

                <div className="top-stat-pill">
                    <span className="ts-label">{t('aircraft')}</span>
                    <span className="ts-value">{planeCount > 0 ? planeCount : t('scanning')} {planeCount > 0 && <span style={{ fontSize: '10px', opacity: 0.7 }}>({airCount}A/{groundCount}G)</span>}</span>
                </div>

                <div className={`top-stat-pill status-indicator ${apiStatusClass || ''}`}>
                    <span className="ts-label">STATUS</span>
                    <span className="ts-value">{apiStatus}</span>
                </div>
            </div>

            {/* Center: Search Box */}
            <div className="top-bar-center">
                <SearchBar
                    planesDict={planesDict}
                    onSelectPlane={onSearchSelect}
                    compact={true}
                />
            </div>

            {/* Right: Settings & Localization */}
            <div className="top-bar-right">
                <button className="tb-btn" onClick={toggleLang}>
                    {lang === 'en' ? 'EN' : '中'}
                </button>

                <div className="settings-dropdown-wrapper">
                    <button
                        className={`tb-btn ${showSettings ? 'active' : ''}`}
                        onClick={() => setShowSettings(!showSettings)}
                    >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.06-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.73,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.06,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.43-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.49-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
                        </svg>
                        Settings
                    </button>

                    {showSettings && (
                        <div className="settings-popover">
                            <FilterPanel
                                filters={filters}
                                onFilterChange={onFilterChange}
                                colorScheme={colorScheme}
                                onColorSchemeChange={onColorSchemeChange}
                                mapLayer={mapLayer}
                                onMapLayerChange={onMapLayerChange}
                                embedded={true}
                            />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
