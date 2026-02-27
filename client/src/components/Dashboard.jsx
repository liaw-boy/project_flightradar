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
}) {
    const [time, setTime] = useState('--:--:--');
    const [isOnline, setIsOnline] = useState(true);
    const [showApiStats, setShowApiStats] = useState(false);
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

    return (
        <div className="dashboard">
            <div className="title-container">
                <div className={`live-dot ${isOnline ? '' : 'offline'}`} />
                <h2>{t('radarSystem')} <span className="version-label">v1.1.20</span></h2>
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
                    <span className="stat-value" style={{ fontSize: '13px' }}>{apiStats?.totalCalls ?? 0}</span>
                </div>

                {apiStats?.accounts?.map((acc, index) => {
                    const maxQuota = 4000;
                    const remaining = acc.remainingCredits !== null ? acc.remainingCredits : 0;
                    const percentage = Math.max(0, Math.min(100, Math.round((remaining / maxQuota) * 100)));

                    // SVG Circle Dash Array Logic
                    const radius = 18;
                    const circumference = 2 * Math.PI * radius;
                    const strokeDashoffset = circumference - (percentage / 100) * circumference;

                    const isLimited = acc.unlockTime && new Date(acc.unlockTime).getTime() > Date.now();
                    const ringColor = isLimited ? '#FF4136' : (percentage < 20 ? '#FFDC00' : '#01FF70');

                    // 計算當天 UTC 00:00 的重置時間 (轉換為當地時間)
                    const now = new Date();
                    const nextResetUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
                    const resetTimeString = nextResetUTC.toLocaleTimeString('en-US', { hour12: false });

                    return (
                        <div key={index} className="account-card">
                            <div className="account-header">
                                <span className="account-name">ID: {acc.user?.split('-')[0] || `ACC-${index + 1}`}</span>
                                <span className={`account-status ${isLimited ? 'danger' : 'healthy'}`}>
                                    {isLimited ? t('restricted') : t('active')}
                                </span>
                            </div>
                            <div className="account-body">
                                <div className="circle-progress">
                                    <svg width="48" height="48">
                                        <circle cx="24" cy="24" r={radius} className="circle-bg" />
                                        <circle cx="24" cy="24" r={radius} className="circle-fg"
                                            style={{
                                                strokeDasharray: circumference,
                                                strokeDashoffset: isLimited ? circumference : strokeDashoffset,
                                                stroke: ringColor
                                            }}
                                        />
                                    </svg>
                                    <div className="circle-text" style={{ color: ringColor }}>
                                        {isLimited ? '0%' : `${percentage}%`}
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
