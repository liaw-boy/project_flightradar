import React, { useMemo, useState, useEffect, useRef } from 'react';
import { BarChart2, X, AlertTriangle, Zap, Layers, Activity, Plane } from 'lucide-react';
import { useI18n } from '../hooks/useI18n';
import './StatsPanel.css';

function topN(map, n = 5) {
    return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n);
}

export default function StatsPanel({ planesDict, anomalyCount, usageStats, onClose }) {
    const { t } = useI18n();
    const [tab, setTab] = useState('overview');

    // FPS tracking
    const [fps, setFps] = useState(60);
    const [fpsHistory, setFpsHistory] = useState([]);
    const frameCount = useRef(0);
    const lastTime = useRef(performance.now());
    const reqRef = useRef(null);

    useEffect(() => {
        const tick = () => {
            const now = performance.now();
            const delta = now - lastTime.current;
            frameCount.current++;
            if (delta >= 1000) {
                const cur = Math.round((frameCount.current * 1000) / delta);
                setFps(cur);
                setFpsHistory(prev => {
                    const next = [...prev, cur];
                    return next.length > 20 ? next.slice(1) : next;
                });
                frameCount.current = 0;
                lastTime.current = now;
            }
            reqRef.current = requestAnimationFrame(tick);
        };
        reqRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(reqRef.current);
    }, []);

    const sparklinePath = fpsHistory.length > 1
        ? `M 0,${20 - (fpsHistory[0] / 60) * 20} ` + fpsHistory.map((v, i) =>
            `L ${(i / (fpsHistory.length - 1)) * 48},${20 - Math.min(1, v / 60) * 20}`
        ).join(' ')
        : '';

    const stats = useMemo(() => {
        const planes = Object.values(planesDict || {});
        const airCount = planes.filter(p => !p.onGround).length;
        const groundCount = planes.filter(p => p.onGround).length;
        const emergencyCount = planes.filter(p => p.isEmergency).length;

        const airlineMap = new Map();
        const typeMap = new Map();
        let totalAlt = 0, altCount = 0;
        let maxSpeed = 0, fastestCallsign = '';

        for (const p of planes) {
            if (p.callsign && p.callsign.length >= 3) {
                const code = p.callsign.slice(0, 3).toUpperCase();
                if (/^[A-Z]{3}$/.test(code)) {
                    airlineMap.set(code, (airlineMap.get(code) || 0) + 1);
                }
            }
            if (p.typecode) {
                const t = p.typecode.toUpperCase();
                typeMap.set(t, (typeMap.get(t) || 0) + 1);
            }
            if (p.altitude > 0 && !p.onGround) {
                totalAlt += p.altitude;
                altCount++;
            }
            if (p.velocity > maxSpeed) {
                maxSpeed = p.velocity;
                fastestCallsign = p.callsign || p.icao24;
            }
        }

        return {
            total: planes.length,
            airCount,
            groundCount,
            emergencyCount,
            avgAlt: altCount > 0 ? Math.round(totalAlt / altCount) : 0,
            maxSpeed: Math.round(maxSpeed),
            fastestCallsign,
            topAirlines: topN(airlineMap),
            topTypes: topN(typeMap),
            uniqueAirlines: airlineMap.size,
            uniqueTypes: typeMap.size,
        };
    }, [planesDict]);

    const fpsColor = fps >= 55 ? '#a9dfd8' : fps >= 30 ? '#f59e0b' : '#ef4444';

    const TABS = [
        { id: 'overview', label: t('statsOverview') },
        { id: 'airlines', label: t('statsAirlines') },
        { id: 'types',    label: t('statsAircraft') },
        { id: 'engine',   label: t('statsEngine') },
    ];

    return (
        <div className="stats-panel">
            <div className="stats-header">
                <div className="stats-title">
                    <BarChart2 size={14} />
                    <span>{t('liveStats')}</span>
                </div>
                <button className="stats-close" onClick={onClose}><X size={14} /></button>
            </div>

            <div className="stats-tabs">
                {TABS.map(tb => (
                    <button key={tb.id} className={`stats-tab${tab === tb.id ? ' active' : ''}`} onClick={() => setTab(tb.id)}>
                        {tb.label}
                    </button>
                ))}
            </div>

            {tab === 'overview' && (
                <div className="stats-body">
                    <div className="stats-grid">
                        <StatBox label={t('statsTotal')}     value={stats.total}         icon={<Plane size={12} />} />
                        <StatBox label={t('statsAirborne')}  value={stats.airCount}      color="#22d3ee" />
                        <StatBox label={t('statsGround')}    value={stats.groundCount}   color="#94a3b8" />
                        <StatBox label={t('statsEmergency')} value={stats.emergencyCount}
                            color={stats.emergencyCount > 0 ? '#ef4444' : undefined}
                            icon={stats.emergencyCount > 0 ? <AlertTriangle size={12} /> : null} />
                    </div>
                    <div className="stats-divider" />
                    <div className="stats-row">
                        <span className="stats-label">{t('statsAvgAlt')}</span>
                        <span className="stats-value">{stats.avgAlt > 0 ? stats.avgAlt.toLocaleString() + ' ft' : '—'}</span>
                    </div>
                    <div className="stats-row">
                        <span className="stats-label">{t('statsFastest')}</span>
                        <span className="stats-value stats-value-mono">
                            {stats.fastestCallsign
                                ? <>{stats.fastestCallsign} <span style={{ color: 'var(--color-text-dim)' }}>{stats.maxSpeed} kts</span></>
                                : '—'}
                        </span>
                    </div>
                    <div className="stats-divider" />
                    <div className="stats-row">
                        <span className="stats-label">{t('statsUniqueAirlines')}</span>
                        <span className="stats-value">{stats.uniqueAirlines || '—'}</span>
                    </div>
                    <div className="stats-row">
                        <span className="stats-label">{t('statsTypes')}</span>
                        <span className="stats-value">{stats.uniqueTypes || '—'}</span>
                    </div>
                </div>
            )}

            {tab === 'airlines' && (
                <div className="stats-body">
                    {stats.topAirlines.length === 0
                        ? <div className="stats-empty">{t('statsNoAirline')}</div>
                        : stats.topAirlines.map(([code, count]) => (
                            <BarRow key={code} label={code} count={count} max={stats.topAirlines[0][1]} />
                        ))
                    }
                </div>
            )}

            {tab === 'types' && (
                <div className="stats-body">
                    {stats.topTypes.length === 0
                        ? <div className="stats-empty">{t('statsNoType')}</div>
                        : stats.topTypes.map(([type, count]) => (
                            <BarRow key={type} label={type} count={count} max={stats.topTypes[0][1]} />
                        ))
                    }
                </div>
            )}

            {tab === 'engine' && (
                <div className="stats-body">
                    <div className="engine-fps-row">
                        <div className="engine-fps-val" style={{ color: fpsColor }}>
                            <Zap size={14} style={{ marginRight: 5 }} />
                            {fps}
                            <span className="engine-fps-unit">FPS</span>
                        </div>
                        {sparklinePath && (
                            <svg width="48" height="20" className="engine-sparkline" style={{ color: fpsColor }}>
                                <path d={sparklinePath} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        )}
                    </div>
                    <div className="stats-divider" />
                    <div className="stats-row">
                        <span className="stats-label"><Layers size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} />{t('statsRendered')}</span>
                        <span className="stats-value">{usageStats?.visibleCount?.toLocaleString() ?? '—'}</span>
                    </div>
                    <div className="stats-row">
                        <span className="stats-label"><Activity size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} />{t('statsInView')}</span>
                        <span className="stats-value">{usageStats?.totalInView?.toLocaleString() ?? '—'}</span>
                    </div>
                    {usageStats?.throttleFactor < 1.0 && (
                        <div className="engine-throttle-warn">
                            {t('statsThrottle')} {usageStats.throttleFactor.toFixed(2)}x
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function StatBox({ label, value, color, icon }) {
    return (
        <div className="stat-box">
            <div className="stat-box-value" style={color ? { color } : {}}>
                {icon && <span style={{ marginRight: 3 }}>{icon}</span>}
                {value}
            </div>
            <div className="stat-box-label">{label}</div>
        </div>
    );
}

function BarRow({ label, count, max }) {
    const pct = max > 0 ? (count / max) * 100 : 0;
    return (
        <div className="bar-row">
            <span className="bar-label">{label}</span>
            <div className="bar-track">
                <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="bar-count">{count}</span>
        </div>
    );
}
