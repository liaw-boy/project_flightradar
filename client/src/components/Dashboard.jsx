import React, { useState, useEffect } from 'react';
import { useI18n } from '../hooks/useI18n';
import './Dashboard.css';

export default function Dashboard({
    planeCount,
    airCount,
    groundCount,
    apiStatus,
    apiStatusClass,
    apiErrorDetail,
    latency,
    lastUpdateTime,
    nextRefresh,
    apiStats,
    zoom, // ADDED PROP
    usageStats, // [v2.3.8] NEW PROP
}) {
    const [time, setTime] = useState('--:--:--');
    const [isOnline, setIsOnline] = useState(true);
    const [showApiStats, setShowApiStats] = useState(false);
    const [showResourceUsage, setShowResourceUsage] = useState(false); // [v2.3.8] Collapsible state
    const { t, lang, toggleLang } = useI18n();

    useEffect(() => {
        const interval = setInterval(() => {
            setTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        setIsOnline(apiStatus !== 'ERROR' && apiStatus !== 'INIT');
    }, [apiStatus]);

    const nextRefreshClass = nextRefresh !== null && nextRefresh <= 5 ? 'stat-warning' : '';

    // [v2.3.8] 計算資源指標
    const displayPercentage = usageStats.totalInView > 0 ? Math.round((usageStats.visibleCount / usageStats.totalInView) * 100) : 100;
    const isThrottled = usageStats.throttleFactor < 1.0;

    return (
        <div className="dashboard">
            <div className="title-container">
                <div className={`live-dot ${isOnline ? '' : 'offline'}`} />
                <h2>{t('radarSystem')} <span className="version-label">v2.3.11</span></h2>
                <button className="lang-toggle" onClick={toggleLang}>
                    {lang === 'en' ? 'EN/中' : '中/EN'}
                </button>
            </div>
            <div className="stat-row">
                <span>{t('sysTime')}</span>
                <span className="stat-value">{time}</span>
            </div>
            <div className="stat-row">
                <span>{t('aircraft')}</span>
                <span className="stat-value">
                    {planeCount > 0 ? String(planeCount) : t('scanning')}
                </span>
            </div>
            <div className="stat-row">
                <span>{t('airGround')}</span>
                <span className="stat-value">
                    {planeCount > 0 ? `${airCount} / ${groundCount}` : '-- / --'}
                </span>
            </div>
            <div className="stat-row">
                <span>{t('zoomLevel') || 'Zoom Level'}</span>
                <span className="stat-value">{zoom}</span>
            </div>
            <div className="stat-row">
                <span>{t('lastUpdate')}</span>
                <span className="stat-value">{lastUpdateTime || '--'}</span>
            </div>
            <div className="stat-row">
                <span>{t('nextRefresh')}</span>
                <span className={`stat-value ${nextRefreshClass}`}>
                    {nextRefresh !== null ? `${nextRefresh}s` : '--'}
                </span>
            </div>

            {apiErrorDetail && (
                <div style={{ marginTop: '10px', fontSize: '11px', color: '#ff4136', wordBreak: 'break-all', border: '1px solid rgba(255,65,54,0.3)', padding: '6px', borderRadius: '4px', background: 'rgba(255,65,54,0.1)' }}>
                    {apiErrorDetail}
                </div>
            )}

            <div className="stat-divider" />

            {/* [v2.3.8] Resource Usage Section */}
            <div
                className={`api-stats-header ${showResourceUsage ? 'open' : ''}`}
                onClick={() => setShowResourceUsage(!showResourceUsage)}
            >
                <span>{t('resourceUsage')}</span>
                <span className="api-stats-icon">▼</span>
            </div>
            <div className={`api-stats-content ${showResourceUsage ? 'open' : ''}`}>
                <div className="stat-row">
                    <span>{t('displayRatio')}</span>
                    <span className="stat-value">{displayPercentage}%</span>
                </div>
                <div className="stat-row">
                    <span>{t('renderLimit')}</span>
                    <span className="stat-value">{usageStats.renderLimit}</span>
                </div>
                <div className="stat-row">
                    <span>{t('throttling')}</span>
                    <span className="stat-value">{usageStats.throttleFactor.toFixed(2)}x</span>
                </div>
                <div className="stat-row">
                    <span>{t('renderStatus')}</span>
                    <span className={`stat-value ${isThrottled ? 'stat-warning' : ''}`} style={{ fontSize: '11px' }}>
                        {isThrottled ? t('statusThrottled') : t('statusNormal')}
                    </span>
                </div>
            </div>

            <div className="stat-divider" />

            <div
                className={`api-stats-header ${showApiStats ? 'open' : ''}`}
                onClick={() => setShowApiStats(!showApiStats)}
            >
                <span>💻 API STATS <span className="api-stats-provider">[{apiStatus}]</span></span>
                <span className="api-stats-icon">▼</span>
            </div>

            <div className={`api-stats-content ${showApiStats ? 'open' : ''}`}>
                <div className="stat-row">
                    <span>{t('apiStatus')}</span>
                    <span className={`stat-value ${apiStatusClass}`} style={{ fontSize: '13px' }}>{apiStatus}</span>
                </div>
                <div className="stat-row">
                    <span>{t('latency')}</span>
                    <span className="stat-value" style={{ fontSize: '13px' }}>
                        {latency !== null ? `${latency}ms` : '--'}
                    </span>
                </div>
                <div className="stat-row">
                    <span>{t('apiCalls')}</span>
                    <span className="stat-value" style={{ fontSize: '13px' }}>
                        {apiStats?.totalCalls ?? 0}
                        <span style={{ fontSize: '10px', opacity: 0.7, marginLeft: '6px' }}>
                            (Next: {nextRefresh}s)
                        </span>
                    </span>
                </div>

                {apiStats?.accounts?.map((acc, index) => {
                    const SAFE_RESERVE_CAP = 50;
                    const maxQuota = 4000;
                    const remaining = acc.remainingCredits !== null ? acc.remainingCredits : 0;
                    const percentage = Math.max(0, Math.min(100, Math.round((remaining / maxQuota) * 100)));

                    // SVG Circle Dash Array Logic
                    const radius = 18;
                    const circumference = 2 * Math.PI * radius;
                    const strokeDashoffset = circumference - (percentage / 100) * circumference;

                    const isLimited = acc.unlockTime && new Date(acc.unlockTime).getTime() > Date.now();
                    const isReserved = !isLimited && remaining !== null && remaining <= SAFE_RESERVE_CAP;
                    const ringColor = isLimited ? '#FF4136' : (isReserved ? '#FF851B' : (percentage < 20 ? '#FFDC00' : '#01FF70'));

                    // 計算當天 UTC 00:00 的重置時間 (轉換為當地時間)
                    const now = new Date();
                    const nextResetUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
                    const resetTimeString = nextResetUTC.toLocaleTimeString('en-US', { hour12: false });

                    return (
                        <div key={index} className="account-card">
                            <div className="account-header">
                                <span className="account-name">ID: {acc.user || `ACC-${index + 1}`}</span>
                                <span className={`account-status ${isLimited ? 'danger' : (isReserved ? 'warning' : 'healthy')}`}>
                                    {isLimited ? t('restricted') : (isReserved ? t('reserved') : t('active'))}
                                </span>
                            </div>
                            <div className="account-body">
                                <div className="circle-progress">
                                    <svg width="48" height="48">
                                        <circle cx="24" cy="24" r={radius} className="circle-bg" />
                                        <circle cx="24" cy="24" r={radius} className="circle-fg"
                                            style={{
                                                strokeDasharray: circumference,
                                                strokeDashoffset: (percentage === 0 && !isLimited) ? circumference : (isLimited ? circumference : strokeDashoffset),
                                                stroke: ringColor
                                            }}
                                        />
                                    </svg>
                                    <div className="circle-text" style={{ color: ringColor }}>
                                        {isLimited ? '0%' : (acc.remainingCredits === null ? '--%' : `${percentage}%`)}
                                    </div>
                                </div>
                                <div className="account-details">
                                    <div className="detail-row">
                                        <span>{t('quota')}</span>
                                        <span style={{ color: ringColor }}>
                                            {isLimited ? '0' : (acc.remainingCredits ?? '--')}
                                        </span>
                                    </div>
                                    {isLimited ? (
                                        <div className="detail-row">
                                            <span style={{ color: '#FFDC00' }}>{t('unlocks')}</span>
                                            <span style={{ color: '#FFDC00' }}>
                                                {new Date(acc.unlockTime).toLocaleTimeString('en-US', { hour12: false })}
                                            </span>
                                        </div>
                                    ) : (
                                        <div className="detail-row">
                                            <span>{t('resets')}</span>
                                            <span style={{ color: 'rgba(255,255,255,0.7)' }}>{resetTimeString}</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
