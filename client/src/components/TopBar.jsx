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
                    <img src="/favicon.svg" alt="Logo" className="brand-logo-img" style={{ width: '24px', height: '24px' }} />
                    <h2>AEROSTRAT RADAR</h2>
                </div>



                <div className="top-stat-pill">
                    <Plane size={14} style={{ color: 'var(--color-text-dim)' }} />
                    <span className="ts-label">{t('aircraft')}</span>
                    <span className="ts-value">{planeCount > 0 ? planeCount : t('scanning')} {planeCount > 0 && <span style={{ fontSize: '11px', opacity: 0.7 }}>({airCount} {t('air')} / {groundCount} {t('gnd')})</span>}</span>


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
