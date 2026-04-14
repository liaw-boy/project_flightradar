import React, { useState, useEffect, useRef } from 'react';
import { Clock, Activity, Settings, Globe, Search, X, BarChart2, User, LogOut, BookOpen, Route, ShieldCheck, Plus } from 'lucide-react';
import { useI18n } from '../hooks/useI18n';
import { authStore } from '../store/authStore';
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
    onOpenAuth,
    onOpenMyFlights,
    onOpenNewFlight,
    onOpenAdmin,
    authUser,
    showUserRoutes = false,
    onToggleUserRoutes,
    hasUserRoutes = false,
}) {
    const { t, lang, toggleLang } = useI18n();
    const [time, setTime] = useState('--:--:--');
    const [showSettings, setShowSettings] = useState(false);
    const [showMobileSearch, setShowMobileSearch] = useState(false);
    const currentUser = authUser ?? null;
    const [showUserMenu, setShowUserMenu] = useState(false);
    const settingsRef = useRef(null);
    const userMenuRef = useRef(null);

    useEffect(() => {
        if (!showUserMenu) return;
        const handler = (e) => {
            if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
                setShowUserMenu(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showUserMenu]);

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

                {/* ── 用戶按鈕 ── */}
                {currentUser ? (
                    <div className="settings-dropdown-wrapper" ref={userMenuRef}>
                        <button
                            className={`tb-btn tb-user-btn ${showUserMenu ? 'active' : ''}`}
                            onClick={() => setShowUserMenu(v => !v)}
                            title={currentUser.username}
                        >
                            <User size={14} />
                            <span className="tb-username">{currentUser.username}</span>
                        </button>
                        {showUserMenu && (
                            <div className="settings-popover user-menu-popover">
                                <button className="user-menu-item" onClick={() => { setShowUserMenu(false); onOpenNewFlight?.(); }}>
                                    <Plus size={14} /> 新增航班記錄
                                </button>
                                <button className="user-menu-item" onClick={() => { setShowUserMenu(false); onOpenMyFlights?.(); }}>
                                    <BookOpen size={14} /> 歷史紀錄
                                </button>
                                {hasUserRoutes && (
                                    <button
                                        className={`user-menu-item${showUserRoutes ? ' active' : ''}`}
                                        onClick={() => { onToggleUserRoutes?.(); setShowUserMenu(false); }}
                                    >
                                        <Route size={14} /> {showUserRoutes ? '隱藏我的航線' : '顯示我的航線'}
                                    </button>
                                )}
                                {!!currentUser?.is_admin && (
                                    <>
                                        <div className="user-menu-divider" />
                                        <button className="user-menu-item admin" onClick={() => { setShowUserMenu(false); onOpenAdmin?.(); }}>
                                            <ShieldCheck size={14} /> 管理後台
                                        </button>
                                    </>
                                )}
                                <div className="user-menu-divider" />
                                <button className="user-menu-item danger" onClick={() => { authStore.logout(); setShowUserMenu(false); }}>
                                    <LogOut size={14} /> 登出
                                </button>
                            </div>
                        )}
                    </div>
                ) : (
                    <button className="tb-btn tb-login-btn" onClick={() => onOpenAuth?.()}>
                        <User size={14} /> 登入
                    </button>
                )}
            </div>
        </div>
    );
}
