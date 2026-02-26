import React, { useState, useEffect } from 'react';
import { useI18n } from '../hooks/useI18n';
import './Dashboard.css';

export default function Dashboard({
    planeCount,
    airCount,
    groundCount,
    apiStatus,
    apiStatusClass,
    latency,
    lastUpdateTime,
    nextRefresh,
    apiStats,
}) {
    const [time, setTime] = useState('--:--:--');
    const [isOnline, setIsOnline] = useState(true);
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
                <h2>{t('radarSystem')} <span style={{ fontSize: '0.6em', color: '#01FF70', opacity: 0.8, marginLeft: '8px', verticalAlign: 'middle', border: '1px solid rgba(1,255,112,0.3)', padding: '2px 4px', borderRadius: '4px' }}>v1.0.23</span></h2>
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
                <span>{t('apiStatus')}</span>
                <span className={`stat-value ${apiStatusClass}`}>{apiStatus}</span>
            </div>
            <div className="stat-row">
                <span>{t('latency')}</span>
                <span className="stat-value">
                    {latency !== null ? `${latency}ms` : '--'}
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

            <div className="stat-divider" />
            <div className="stat-row">
                <span>{t('apiCalls')}</span>
                <span className="stat-value">{apiStats?.totalCalls ?? 0}</span>
            </div>
            <div className="stat-row">
                <span>{t('rateLimits')}</span>
                <span className={`stat-value ${(apiStats?.rateLimits || 0) > 0 ? 'stat-warning' : ''}`}>
                    {apiStats?.rateLimits ?? 0}
                </span>
            </div>
            <div className="stat-row">
                <span>{t('dbCache')}</span>
                <span className="stat-value">{apiStats?.metadataCacheSize ?? 0}</span>
            </div>
        </div>
    );
}
