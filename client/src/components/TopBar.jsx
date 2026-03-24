import React, { useState, useEffect } from 'react';
import { Clock, Plane, Activity, Settings, Globe } from 'lucide-react';
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
    onMapLayerChange,
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
                    <Globe size={20} className="brand-icon" style={{ color: 'var(--color-accent-cyan)' }} />
                    <h2>AEROSTRAT</h2>
                </div>
                <div className="brand-subtitle">
                    <span className="brand-highlight">RADAR</span>
                    <span className="brand-version">v5.0.0</span>
                </div>

                <div className="top-stat-pill">
                    <Clock size={14} style={{ color: 'var(--color-text-dim)' }} />
                    <span className="ts-label">{t('sysTime')}</span>
                    <span className="ts-value">{time}</span>
                </div>

                <div className="top-stat-pill">
                    <Plane size={14} style={{ color: 'var(--color-text-dim)' }} />
                    <span className="ts-label">{t('aircraft')}</span>
                    <span className="ts-value">{planeCount > 0 ? planeCount : t('scanning')} {planeCount > 0 && <span style={{ fontSize: '11px', opacity: 0.7 }}>({airCount}A/{groundCount}G)</span>}</span>
                </div>

                <div className={`top-stat-pill status-indicator ${apiStatusClass || ''}`}>
                    <Activity size={14} style={{ color: 'var(--color-text-dim)' }} />
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
                        <Settings size={16} />
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
