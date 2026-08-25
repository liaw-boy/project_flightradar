import React, { useState, useEffect, useRef } from 'react';
import { Clock, Activity, Settings, Globe, Search, X, Sun, Moon } from 'lucide-react';
import { useI18n } from '../hooks/useI18n';
import SearchBar from './SearchBar';
import FilterPanel from './FilterPanel';
import AeroIcon from './AeroIcon';
import './TopBar.css';

export default function TopBar({
    planeCount,
    airCount,
    groundCount,
    apiStatus,
    apiStatusClass,
    sseStale = false,
    planesDict,
    onSearchSelect,
    filters,
    onFilterChange,
    mapLayer,
    onMapLayerChange,
    theme,
    onToggleTheme,
    onRecenter,
}) {
    const { t, lang, toggleLang } = useI18n();
    const [time, setTime] = useState('--:--:--');
    const [showSettings, setShowSettings] = useState(false);
    const [showMobileSearch, setShowMobileSearch] = useState(false);
    const [dataFreshness, setDataFreshness] = useState(null);
    const settingsRef = useRef(null);

    useEffect(() => {
        const interval = setInterval(() => {
            setTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        fetch('/api/data-freshness')
            .then(r => r.json())
            .then(setDataFreshness)
            .catch(() => {});
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
                <div
                    className={`brand-logo${onRecenter ? ' brand-logo--clickable' : ''}`}
                    onClick={onRecenter}
                    title={onRecenter ? '回到地圖中心' : undefined}
                >
                    <AeroIcon size={28} bg={false} />
                    <h2><span className="brand-name">AEROSTRAT</span><span className="brand-suffix"> RADAR</span></h2>
                </div>
                {(sseStale || dataFreshness?.anyStale) && (
                    <div className="brand-subtitle">
                        {sseStale && (
                            <span className="tb-stale-badge" title="即時推送斷線 8 秒以上，飛機可能未即時更新">
                                LIVE LOST
                            </span>
                        )}
                        {!sseStale && dataFreshness?.anyStale && (
                            <span className="tb-stale-badge tb-stale-db" title="背景資料更新已過期">
                                DATA STALE
                            </span>
                        )}
                    </div>
                )}
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
                    className="tb-btn tb-icon-btn"
                    onClick={onToggleTheme}
                    title={theme === 'light' ? '切換深色模式' : '切換淺色模式'}
                >
                    {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
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
