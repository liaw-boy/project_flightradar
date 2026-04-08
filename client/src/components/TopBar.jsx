import React, { useState, useEffect, useRef } from 'react';
import { Clock, Activity, Settings, Globe, Search, X, BarChart2 } from 'lucide-react';
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
    showStats,
    onToggleStats,
}) {
    const { t, lang, toggleLang } = useI18n();
    const [time, setTime] = useState('--:--:--');
    const [showSettings, setShowSettings] = useState(false);
    const [showMobileSearch, setShowMobileSearch] = useState(false);
    const settingsRef = useRef(null);

    useEffect(() => {
        const interval = setInterval(() => {
            setTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (!showSettings) return;
        const handleClickOutside = (e) => {
            if (settingsRef.current && !settingsRef.current.contains(e.target)) {
                setShowSettings(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [showSettings]);

    return (
        <div className={`top-bar${showMobileSearch ? ' mobile-search-open' : ''}`}>
            {/* Left: Branding & Core Stats */}
            <div className="top-bar-left">
                <div className="brand-logo">
                    <img src="/favicon.svg" alt="Logo" className="brand-logo-img" style={{ width: '24px', height: '24px' }} />
                    <h2>AEROSTRAT RADAR</h2>
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

                <button
                    className={`tb-btn ${showStats ? 'active' : ''}`}
                    onClick={onToggleStats}
                    title="Live Stats"
                >
                    <BarChart2 size={16} />
                </button>

                <button className="tb-btn tb-lang-btn" onClick={toggleLang}>
                    {lang === 'en' ? 'EN' : '中'}
                </button>

                <div className="settings-dropdown-wrapper" ref={settingsRef}>
                    <button
                        className={`tb-btn tb-icon-btn ${showSettings ? 'active' : ''}`}
                        onClick={() => setShowSettings(!showSettings)}
                        title={t('settings')}
                    >
                        <Settings size={16} />
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
