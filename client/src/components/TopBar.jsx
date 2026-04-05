import React, { useState, useEffect } from 'react';
import { Clock, Plane, Activity, Settings, Globe, Search, X } from 'lucide-react';
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
    const [showMobileSearch, setShowMobileSearch] = useState(false);

    useEffect(() => {
        const interval = setInterval(() => {
            setTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className={`top-bar${showMobileSearch ? ' mobile-search-open' : ''}`}>
            {/* Left: Branding & Core Stats */}
            <div className="top-bar-left">
                <div className="brand-logo">
                    <img src="/favicon.svg" alt="Logo" className="brand-logo-img" style={{ width: '24px', height: '24px' }} />
                    <h2>AEROSTRAT RADAR</h2>
                </div>



                <div className="top-stat-pill">
                    <Plane size={14} style={{ color: 'var(--color-text-dim)' }} />
                    <span className="ts-label">{t('aircraft')}</span>
                    <span className="ts-value">
                        {planeCount > 0 ? planeCount : t('scanning')}
                        {planeCount > 0 && <span className="ts-sub"> {airCount}/{groundCount}</span>}
                    </span>


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

            {/* Mobile Search Overlay（≤850px 展開時覆蓋整個 TopBar） */}
            {showMobileSearch && (
                <div className="mobile-search-overlay">
                    <SearchBar
                        planesDict={planesDict}
                        onSelectPlane={(p) => { onSearchSelect(p); setShowMobileSearch(false); }}
                        compact={true}
                        autoFocus={true}
                    />
                    <button className="tb-btn mobile-search-close" onClick={() => setShowMobileSearch(false)}>
                        <X size={16} />
                    </button>
                </div>
            )}

            {/* Right: Settings & Localization */}
            <div className="top-bar-right">
                {/* 搜尋圖示（只在 ≤850px 且搜尋欄隱藏時顯示） */}
                <button className="tb-btn tb-search-icon" onClick={() => setShowMobileSearch(true)} aria-label="Search">
                    <Search size={16} />
                </button>

                <button className="tb-btn" onClick={toggleLang}>
                    {lang === 'en' ? 'EN' : '中'}
                </button>

                <div className="settings-dropdown-wrapper">
                    <button
                        className={`tb-btn ${showSettings ? 'active' : ''}`}
                        onClick={() => setShowSettings(!showSettings)}
                    >
                        <Settings size={16} />
                        <span>{t('filters')}</span>
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
