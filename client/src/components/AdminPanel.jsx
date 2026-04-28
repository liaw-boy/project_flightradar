import React, { useState, useEffect, useCallback } from 'react';
import {
    ArrowLeft, Users, Activity, Trash2, ShieldCheck,
    RefreshCw, Plane, Database, Wifi, Cpu, BarChart2, LogOut,
    AlertTriangle, X, Clock, HardDrive, Server, Zap
} from 'lucide-react';
import { authStore } from '../store/authStore';
import './AdminPanel.css';

// ── Radial Gauge (conic-gradient) ────────────────────────────────────────────
function RadialGauge({ pct = 0, color = 'var(--accent)', size = 58, label }) {
    const clamped = Math.max(0, Math.min(100, pct));
    return (
        <div
            className="adm-gauge"
            style={{ '--gp': `${clamped}%`, '--gc': color, width: size, height: size }}
        >
            <div className="adm-gauge-inner">
                <span className="adm-gauge-label">{label}</span>
            </div>
        </div>
    );
}

// ── Confirm Dialog ────────────────────────────────────────────────────────────
function ConfirmDialog({ title, message, variant = 'danger', confirmLabel = '確認', onConfirm, onCancel }) {
    return (
        <div className="adm-dialog-backdrop" onClick={onCancel}>
            <div className="adm-dialog" onClick={e => e.stopPropagation()}>
                <div className={`adm-dialog-icon adm-dialog-icon--${variant}`}>
                    <AlertTriangle size={22} />
                </div>
                <h3 className="adm-dialog-title">{title}</h3>
                <p className="adm-dialog-msg">{message}</p>
                <div className="adm-dialog-actions">
                    <button className="adm-dialog-cancel" onClick={onCancel}>取消</button>
                    <button className={`adm-dialog-confirm adm-dialog-confirm--${variant}`} onClick={onConfirm}>
                        {confirmLabel}
                    </button>
                </div>
                <button className="adm-dialog-close" onClick={onCancel}><X size={14} /></button>
            </div>
        </div>
    );
}

function authHeader() {
    const token = authStore.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Users Tab ────────────────────────────────────────────────────────────────
function UsersTab() {
    const [users, setUsers]       = useState([]);
    const [loading, setLoading]   = useState(true);
    const [error, setError]       = useState(null);
    const [dialog, setDialog]     = useState(null); // { title, message, variant, confirmLabel, onConfirm }

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try {
            const r = await fetch('/api/admin/users', { headers: authHeader() });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const { users: list } = await r.json();
            setUsers(list);
        } catch (e) { setError(e.message); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { load(); }, [load]);

    function ask(opts) {
        return new Promise(resolve => {
            setDialog({
                ...opts,
                onConfirm: () => { setDialog(null); resolve(true);  },
                onCancel:  () => { setDialog(null); resolve(false); },
            });
        });
    }

    async function del(id, name) {
        const ok = await ask({
            title:        '刪除用戶',
            message:      `確定要刪除用戶「${name}」嗎？此操作無法復原，該帳號所有資料將永久移除。`,
            variant:      'danger',
            confirmLabel: '確認刪除',
        });
        if (!ok) return;
        const r = await fetch(`/api/admin/users/${id}`, { method: 'DELETE', headers: authHeader() });
        const j = await r.json();
        if (j.ok) setUsers(u => u.filter(x => x.id !== id));
        else setError('刪除失敗：' + (j.error || 'unknown'));
    }

    async function toggleAdmin(id, isCurrentlyAdmin, name) {
        const ok = await ask(isCurrentlyAdmin
            ? {
                title:        '移除管理員身份',
                message:      `確定要移除「${name}」的管理員身份嗎？該用戶將失去所有後台管理權限。`,
                variant:      'warning',
                confirmLabel: '確認移除',
            }
            : {
                title:        '授予管理員身份',
                message:      `確定要將「${name}」設為管理員嗎？該用戶將獲得後台管理權限。`,
                variant:      'info',
                confirmLabel: '確認授予',
            }
        );
        if (!ok) return;
        const r = await fetch(`/api/admin/users/${id}/admin`, { method: 'PUT', headers: authHeader() });
        const j = await r.json();
        if (j.ok) setUsers(u => u.map(x => x.id === id ? { ...x, is_admin: j.is_admin } : x));
        else setError('操作失敗：' + (j.error || 'unknown'));
    }

    return (
        <div className="adm-content">
            {dialog && <ConfirmDialog {...dialog} />}

            <div className="adm-page-hd">
                <div>
                    <h1 className="adm-page-title">用戶管理</h1>
                    <p className="adm-page-sub">管理所有已註冊帳號</p>
                </div>
                <button className="adm-action-btn" onClick={load} disabled={loading}>
                    <RefreshCw size={14} className={loading ? 'adm-spin' : ''} /> 重新載入
                </button>
            </div>

            {error && <div className="adm-alert adm-alert-err">{error}</div>}

            <div className="adm-card">
                <div className="adm-card-hd">
                    <span className="adm-card-title">帳號列表</span>
                    <span className="adm-badge-count">{users.length} 個帳號</span>
                </div>
                {loading ? (
                    <div className="adm-empty">載入中…</div>
                ) : users.length === 0 ? (
                    <div className="adm-empty">目前沒有用戶</div>
                ) : (
                    <div className="adm-table-wrap">
                        <table className="adm-table">
                            <thead>
                                <tr>
                                    <th>ID</th>
                                    <th>用戶名</th>
                                    <th>Email</th>
                                    <th>角色</th>
                                    <th>加入日期</th>
                                    <th>操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                {users.map(u => (
                                    <tr key={u.id}>
                                        <td className="adm-td-muted">{u.id}</td>
                                        <td>
                                            <div className="adm-user-cell">
                                                <div className="adm-avatar" style={{ background: u.avatar_color || '#4CAF50' }}>
                                                    {u.username[0].toUpperCase()}
                                                </div>
                                                <span className="adm-td-bold">{u.username}</span>
                                            </div>
                                        </td>
                                        <td className="adm-td-muted">{u.email || '—'}</td>
                                        <td>
                                            {u.is_superadmin
                                                ? <span className="adm-role adm-role-super"><ShieldCheck size={11} /> 超級管理員</span>
                                                : u.is_admin
                                                    ? <span className="adm-role adm-role-admin"><ShieldCheck size={11} /> 管理員</span>
                                                    : <span className="adm-role adm-role-user">用戶</span>}
                                        </td>
                                        <td className="adm-td-muted adm-td-sm">
                                            {new Date(u.created_at * 1000).toLocaleDateString('zh-TW')}
                                        </td>
                                        <td>
                                            <div className="adm-row-actions">
                                                {!u.is_superadmin && (
                                                    u.is_admin
                                                        ? <button className="adm-btn adm-btn-warning" onClick={() => toggleAdmin(u.id, true, u.username)}>
                                                            <ShieldCheck size={12} /> 取消管理員
                                                          </button>
                                                        : <button className="adm-btn adm-btn-teal" onClick={() => toggleAdmin(u.id, false, u.username)}>
                                                            <ShieldCheck size={12} /> 設管理員
                                                          </button>
                                                )}
                                                {!u.is_superadmin && (
                                                    <button className="adm-btn adm-btn-danger" onClick={() => del(u.id, u.username)}>
                                                        <Trash2 size={12} /> 刪除
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Monitor Tab ──────────────────────────────────────────────────────────────
function MonitorTab() {
    const [health, setHealth]   = useState(null);
    const [stats, setStats]     = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError]     = useState(null);
    const [lastRefresh, setLastRefresh] = useState(null);

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try {
            const hdrs = authHeader();
            const [hr, sr] = await Promise.all([
                fetch('/api/health', { headers: hdrs }),
                fetch('/api/stats',  { headers: hdrs }),
            ]);
            if (!hr.ok || !sr.ok) throw new Error(`HTTP ${hr.status}/${sr.status}`);
            const [h, s] = await Promise.all([hr.json(), sr.json()]);
            setHealth(h); setStats(s);
            setLastRefresh(new Date().toLocaleTimeString('zh-TW', { hour12: false }));
        } catch (e) { setError(e.message); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => {
        load();
        const t = setInterval(load, 10000);
        return () => clearInterval(t);
    }, [load]);

    const fmt = b => {
        if (!b) return '0 B';
        if (b >= 1073741824) return (b/1073741824).toFixed(2) + ' GB';
        if (b >= 1048576)    return (b/1048576).toFixed(1)    + ' MB';
        if (b >= 1024)       return (b/1024).toFixed(1)       + ' KB';
        return b + ' B';
    };

    const uptimeStr = s => {
        if (!s) return '—';
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    const sys = health?.performance?.system;
    const mem = health?.performance?.process?.memory;

    const cpuPct   = sys?.cpuUsage ?? 0;
    const cpuColor = cpuPct > 80 ? '#ef4444' : cpuPct > 50 ? '#f59e0b' : '#10b981';
    const loadVal  = sys?.load?.[0] ?? 0;
    const loadColor = loadVal > (sys?.cpuCores ?? 4) * 0.8 ? '#ef4444' : loadVal > (sys?.cpuCores ?? 4) * 0.5 ? '#f59e0b' : '#10b981';
    const memFreePct = sys ? Math.round((sys.freeMem / (sys.totalMem || 1)) * 100) : 0;
    const heapPct  = mem ? Math.round((mem.heapUsed / (mem.heapTotal || 1)) * 100) : 0;

    return (
        <div className="adm-content">
            <div className="adm-page-hd">
                <div>
                    <h1 className="adm-page-title">系統監控</h1>
                    <p className="adm-page-sub">{lastRefresh ? `最後更新：${lastRefresh}` : '載入中…'}</p>
                </div>
                <button className="adm-action-btn" onClick={load} disabled={loading}>
                    <RefreshCw size={14} className={loading ? 'adm-spin' : ''} /> 立即刷新
                </button>
            </div>

            {error && <div className="adm-alert adm-alert-err">{error}</div>}

            {/* ── KPI Row ── */}
            <div className="adm-kpi-grid">
                <div className="adm-kpi-card adm-kpi-accent-blue">
                    <div className="adm-kpi-icon adm-kpi-blue"><Plane size={18} /></div>
                    <div className="adm-kpi-body">
                        <div className="adm-kpi-val">{health?.cacheSize ?? '—'}</div>
                        <div className="adm-kpi-lbl">追蹤飛機</div>
                    </div>
                </div>
                <div className="adm-kpi-card adm-kpi-accent-green">
                    <div className="adm-kpi-icon adm-kpi-green"><Activity size={18} /></div>
                    <div className="adm-kpi-body">
                        <div className="adm-kpi-val adm-val-green">{health?.activeSessions ?? '—'}</div>
                        <div className="adm-kpi-lbl">活躍 Sessions</div>
                    </div>
                </div>
                <div className="adm-kpi-card adm-kpi-accent-purple">
                    <div className="adm-kpi-icon adm-kpi-purple"><Wifi size={18} /></div>
                    <div className="adm-kpi-body">
                        <div className="adm-kpi-val">{health?.ingestion?.totalPoints?.toLocaleString() ?? '—'}</div>
                        <div className="adm-kpi-lbl">收錄航跡點</div>
                    </div>
                </div>
                <div className="adm-kpi-card adm-kpi-accent-yellow">
                    <div className="adm-kpi-icon adm-kpi-yellow"><BarChart2 size={18} /></div>
                    <div className="adm-kpi-body">
                        <div className="adm-kpi-val">{stats?.totalCalls ?? '—'}</div>
                        <div className="adm-kpi-lbl">API 呼叫總數</div>
                    </div>
                </div>
                <div className="adm-kpi-card adm-kpi-accent-teal">
                    <div className="adm-kpi-icon adm-kpi-teal"><Database size={18} /></div>
                    <div className="adm-kpi-body">
                        <div className="adm-kpi-val adm-val-sm">{health?.storage?.dbSize ? fmt(health.storage.dbSize) : '—'}</div>
                        <div className="adm-kpi-lbl">資料庫大小</div>
                    </div>
                </div>
                <div className="adm-kpi-card adm-kpi-accent-gray">
                    <div className="adm-kpi-icon adm-kpi-gray"><Clock size={18} /></div>
                    <div className="adm-kpi-body">
                        <div className="adm-kpi-val adm-val-sm">{uptimeStr(health?.uptime)}</div>
                        <div className="adm-kpi-lbl">運行時間</div>
                    </div>
                </div>
            </div>

            {/* ── System Resources ── */}
            {sys && (
                <div className="adm-card adm-mb">
                    <div className="adm-card-hd">
                        <span className="adm-card-title"><Server size={14} style={{ display:'inline', marginRight:6, verticalAlign:'middle' }} />系統資源</span>
                        <span className="adm-badge-count">{sys.cpuCores ?? '?'} 核 CPU</span>
                    </div>
                    <div className="adm-sysres-grid2">
                        {/* CPU gauge */}
                        <div className="adm-sysres2-card">
                            <RadialGauge pct={cpuPct} color={cpuColor} label={`${cpuPct.toFixed(1)}%`} />
                            <div className="adm-sysres2-info">
                                <span className="adm-sysres2-lbl">CPU 使用率</span>
                                <span className="adm-sysres2-sub" style={{ color: cpuColor }}>
                                    {cpuPct > 80 ? '負載偏高' : cpuPct > 50 ? '負載適中' : '運作正常'}
                                </span>
                            </div>
                        </div>

                        {/* System Load gauge */}
                        <div className="adm-sysres2-card">
                            <RadialGauge
                                pct={Math.min(100, (loadVal / (sys.cpuCores || 4)) * 100)}
                                color={loadColor}
                                label={loadVal.toFixed(2)}
                                size={58}
                            />
                            <div className="adm-sysres2-info">
                                <span className="adm-sysres2-lbl">系統負載</span>
                                <span className="adm-sysres2-sub" style={{ color: loadColor }}>1 分鐘均值</span>
                            </div>
                        </div>

                        {/* Memory bar */}
                        <div className="adm-sysres2-card adm-sysres2-card--wide">
                            <div className="adm-sysres2-bargroup">
                                <div className="adm-sysres2-barrow">
                                    <span className="adm-sysres2-barlbl">可用記憶體</span>
                                    <span className="adm-sysres2-barval">{fmt(sys.freeMem)} / {fmt(sys.totalMem)}</span>
                                </div>
                                <div className="adm-sysres2-track">
                                    <div className="adm-sysres2-fill adm-sysres2-fill--mem" style={{ width: `${memFreePct}%` }} />
                                </div>
                                <div className="adm-sysres2-barrow" style={{ marginTop: 14 }}>
                                    <span className="adm-sysres2-barlbl">磁碟剩餘</span>
                                    <span className="adm-sysres2-barval">{sys.disk?.free ? fmt(sys.disk.free) : '—'}</span>
                                </div>
                                <div className="adm-sysres2-track">
                                    <div className="adm-sysres2-fill adm-sysres2-fill--disk" style={{
                                        width: sys.disk?.total ? `${Math.round((sys.disk.free / sys.disk.total) * 100)}%` : '0%'
                                    }} />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="adm-two-col">
                {/* OpenSky Accounts */}
                {stats?.accounts?.length > 0 && (
                    <div className="adm-card">
                        <div className="adm-card-hd">
                            <span className="adm-card-title"><Zap size={14} style={{ display:'inline', marginRight:6, verticalAlign:'middle' }} />OpenSky 帳號配額</span>
                            <span className="adm-badge-count">{stats.accounts.length} 個帳號</span>
                        </div>
                        <div className="adm-card-body">
                            {stats.accounts.map(a => {
                                const total = (a.remainingCredits ?? 0) + (a.dailyUsed ?? 0);
                                const pct   = total > 0 ? Math.round((a.dailyUsed ?? 0) / total * 100) : 0;
                                const low   = (a.remainingCredits ?? 999) < 500;
                                return (
                                    <div key={a.user} className="adm-quota-row">
                                        <div className="adm-quota-info">
                                            <div className="adm-quota-left">
                                                <div className={`adm-quota-dot ${low ? 'adm-quota-dot--warn' : 'adm-quota-dot--ok'}`} />
                                                <span className="adm-quota-name">{a.user}</span>
                                            </div>
                                            <div className="adm-quota-right">
                                                <span className={`adm-quota-num ${low ? 'adm-warn' : 'adm-ok'}`}>{a.remainingCredits ?? '?'}</span>
                                                <span className="adm-quota-unit"> 剩餘</span>
                                            </div>
                                        </div>
                                        <div className="adm-quota-bar">
                                            <div className={`adm-quota-fill ${low ? 'adm-fill-warn' : 'adm-fill-ok'}`} style={{ width: pct + '%' }} />
                                        </div>
                                        <div className="adm-quota-pct">{pct}% 已用</div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Process Memory */}
                {mem && (
                    <div className="adm-card">
                        <div className="adm-card-hd">
                            <span className="adm-card-title"><HardDrive size={14} style={{ display:'inline', marginRight:6, verticalAlign:'middle' }} />進程記憶體</span>
                            <span className="adm-badge-count">Heap {heapPct}%</span>
                        </div>
                        <div className="adm-card-body adm-card-body--center">
                            <RadialGauge pct={heapPct} color={heapPct > 85 ? '#ef4444' : heapPct > 60 ? '#f59e0b' : 'var(--accent)'} label={`${heapPct}%`} size={72} />
                            <div className="adm-mem-list">
                                {[
                                    ['Heap Used',  mem.heapUsed,  mem.heapTotal],
                                    ['RSS',        mem.rss,       mem.rss],
                                    ['External',   mem.external,  mem.rss],
                                ].map(([lbl, val, base]) => val != null && (
                                    <div key={lbl} className="adm-mem-row">
                                        <span className="adm-mem-lbl">{lbl}</span>
                                        <div className="adm-mem-bar-wrap">
                                            <div className="adm-mem-bar">
                                                <div className="adm-mem-fill" style={{ width: Math.min(100, val / (base || 1) * 100) + '%' }} />
                                            </div>
                                            <span className="adm-mem-val">{fmt(val)}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Data Sources */}
            {stats?.sourceHealth && (
                <div className="adm-card">
                    <div className="adm-card-hd">
                        <span className="adm-card-title"><Activity size={14} style={{ display:'inline', marginRight:6, verticalAlign:'middle' }} />資料來源狀態</span>
                        <span className="adm-badge-count">{stats.totalPlanes?.toLocaleString() ?? '—'} 架飛機</span>
                    </div>
                    <div className="adm-source-grid">
                        {Object.entries(stats.sourceHealth).map(([name, s]) => {
                            const tripped  = s.cbUntil > Date.now();
                            const staleSec = s.lastOk ? Math.round((Date.now() - s.lastOk) / 1000) : null;
                            const stale    = staleSec !== null && staleSec > 60;
                            const status   = tripped ? 'trip' : stale ? 'warn' : 'ok';
                            const label    = { 'adsb.fi-snap': 'adsb.fi', 'adsb.lol': 'adsb.lol', 'al-mil': 'AL Military', 'al-ladd': 'AL LADD' }[name] ?? name;
                            const isPrimary = name === 'adsb.fi-snap' || name === 'adsb.lol';
                            return (
                                <div key={name} className={`adm-source-card adm-source-${status}`}>
                                    <div className="adm-source-top">
                                        <div className="adm-source-dot" />
                                        <span className="adm-source-name">{label}</span>
                                        {isPrimary && <span className="adm-source-tag">主要</span>}
                                    </div>
                                    <div className="adm-source-stats">
                                        <div className="adm-source-stat">
                                            <span className="adm-source-stat-val">{s.lastCount?.toLocaleString() ?? '—'}</span>
                                            <span className="adm-source-stat-lbl">架飛機</span>
                                        </div>
                                        <div className="adm-source-stat">
                                            <span className="adm-source-stat-val">{s.lastLatency ? `${s.lastLatency}ms` : '—'}</span>
                                            <span className="adm-source-stat-lbl">延遲</span>
                                        </div>
                                        <div className="adm-source-stat">
                                            <span className="adm-source-stat-val">{staleSec !== null ? (staleSec < 60 ? `${staleSec}s` : `${Math.floor(staleSec/60)}m`) : '—'}</span>
                                            <span className="adm-source-stat-lbl">上次更新</span>
                                        </div>
                                    </div>
                                    {tripped && (
                                        <div className="adm-source-cb">熔斷至 {new Date(s.cbUntil).toLocaleTimeString('zh-TW', { hour12: false })}</div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Main Full-Page Layout ────────────────────────────────────────────────────
const NAV = [
    { id: 'users',   label: '用戶管理', icon: Users },
    { id: 'monitor', label: '系統監控', icon: Activity },
];

export default function AdminPanel({ onClose }) {
    const [tab, setTab] = useState('users');
    const [showUserMenu, setShowUserMenu] = useState(false);
    const user = authStore.getUser?.() ?? null;

    return (
        <div className="adm-page">
            {/* Sidebar */}
            <aside className="adm-sidebar">
                <div className="adm-brand">
                    <svg className="adm-brand-icon" viewBox="0 0 24 24" fill="none" stroke="#a9dfd8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/>
                    </svg>
                    <div>
                        <div className="adm-brand-name">AEROSTRAT</div>
                        <div className="adm-brand-sub">管理後台</div>
                    </div>
                </div>

                <nav className="adm-nav">
                    {NAV.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            className={`adm-nav-item ${tab === id ? 'active' : ''}`}
                            onClick={() => setTab(id)}
                        >
                            <Icon size={16} />
                            <span>{label}</span>
                        </button>
                    ))}
                </nav>

                <div className="adm-sidebar-footer">
                    {user && (
                        <div className="adm-user-wrap">
                            <button
                                className={`adm-current-user adm-current-user-btn ${showUserMenu ? 'active' : ''}`}
                                onClick={() => setShowUserMenu(v => !v)}
                                title="帳號選項"
                            >
                                <div className="adm-avatar adm-avatar-sm" style={{ background: user.avatar_color || '#4CAF50' }}>
                                    {user.username?.[0]?.toUpperCase()}
                                </div>
                                <div className="adm-cu-text">
                                    <div className="adm-cu-name">{user.username}</div>
                                    <div className="adm-cu-role">管理員</div>
                                </div>
                            </button>
                            {showUserMenu && (
                                <div className="adm-user-popup">
                                    <button className="adm-popup-item adm-popup-danger" onClick={() => { authStore.logout(); onClose(); }}>
                                        <LogOut size={13} /> 登出
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    <button className="adm-back-btn" onClick={onClose}>
                        <ArrowLeft size={15} />
                        <span>回到地圖</span>
                    </button>
                </div>
            </aside>

            {/* Main */}
            <main className="adm-main">
                {tab === 'users'   && <UsersTab />}
                {tab === 'monitor' && <MonitorTab />}
            </main>
        </div>
    );
}
