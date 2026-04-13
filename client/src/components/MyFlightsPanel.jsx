import React, { useState, useEffect, useCallback } from 'react';
import {
    X, Plus, Pencil, Trash2, Plane, MapPin, Calendar,
    ChevronLeft, ChevronRight, AlertCircle, CheckCircle, BarChart2
} from 'lucide-react';
import {
    apiListFlights, apiCreateFlight, apiUpdateFlight,
    apiDeleteFlight, apiFlightStats
} from '../store/authStore';
import './MyFlightsPanel.css';

// ── 空白表單 ──────────────────────────────────────────────────────────────────
const EMPTY_FORM = {
    flight_date: '', flight_number: '', callsign: '', icao24: '',
    aircraft_type: '', registration: '', dep_icao: '', arr_icao: '',
    dep_time: '', arr_time: '', seat_number: '', seat_class: '', notes: '',
};

// ── 艙等選項 ─────────────────────────────────────────────────────────────────
const SEAT_CLASSES = ['經濟艙', '豪華經濟艙', '商務艙', '頭等艙'];

// ── 子元件：統計卡（可點擊展開詳細儀表板）────────────────────────────────────
function StatsBar({ stats, onShowStats }) {
    if (!stats) return null;
    return (
        <div className="mfp-stats-bar" onClick={onShowStats} title="點擊查看詳細統計" style={{ cursor: 'pointer' }}>
            <div className="mfp-stat">
                <span className="mfp-stat-label">FLIGHTS</span>
                <span className="mfp-stat-v">{stats.total_flights}</span>
                <span className="mfp-stat-unit">SECTORS</span>
            </div>
            <div className="mfp-stat">
                <span className="mfp-stat-label">DISTANCE</span>
                <span className="mfp-stat-v">{stats.total_km >= 1000 ? `${(stats.total_km / 1000).toFixed(1)}k` : stats.total_km}</span>
                <span className="mfp-stat-unit">KM TOTAL</span>
            </div>
            <div className="mfp-stat">
                <span className="mfp-stat-label">AIRPORTS</span>
                <span className="mfp-stat-v">{stats.total_airports}</span>
                <span className="mfp-stat-unit">VISITED</span>
            </div>
            <div className="mfp-stat mfp-stat-cta">
                <span className="mfp-stat-label">DETAILS</span>
                <span className="mfp-stat-v">→</span>
            </div>
        </div>
    );
}

// ── 子元件：詳細統計儀表板 ────────────────────────────────────────────────────
function StatsDashboard({ stats, onBack }) {
    if (!stats) return null;
    const maxAc = stats.top_aircraft?.[0]?.count || 1;
    const maxRt = stats.top_routes?.[0]?.count || 1;
    return (
        <div className="mfp-stats-dashboard">
            <div className="mfp-dash-back" onClick={onBack}>← 返回航班記錄</div>

            {/* 大數字摘要 */}
            <div className="mfp-dash-summary">
                <div className="mfp-dash-num">
                    <span className="mfp-dash-big">{stats.total_flights}</span>
                    <span className="mfp-dash-lbl">SECTORS</span>
                </div>
                <div className="mfp-dash-num">
                    <span className="mfp-dash-big">
                        {stats.total_km >= 1000
                            ? `${(stats.total_km / 1000).toFixed(1)}k`
                            : stats.total_km}
                    </span>
                    <span className="mfp-dash-lbl">KM FLOWN</span>
                </div>
                <div className="mfp-dash-num">
                    <span className="mfp-dash-big">{stats.total_airports}</span>
                    <span className="mfp-dash-lbl">AIRPORTS</span>
                </div>
            </div>

            {/* 最常搭機型 */}
            {stats.top_aircraft?.length > 0 && (
                <div className="mfp-dash-section">
                    <div className="mfp-dash-section-title">▸ TOP AIRCRAFT TYPES</div>
                    {stats.top_aircraft.map(({ type, count }) => (
                        <div key={type} className="mfp-dash-bar-row">
                            <span className="mfp-dash-bar-label">{type}</span>
                            <div className="mfp-dash-bar-track">
                                <div className="mfp-dash-bar-fill" style={{ width: `${(count / maxAc) * 100}%` }} />
                            </div>
                            <span className="mfp-dash-bar-count">{count}</span>
                        </div>
                    ))}
                </div>
            )}

            {/* 最常飛航線 */}
            {stats.top_routes?.length > 0 && (
                <div className="mfp-dash-section">
                    <div className="mfp-dash-section-title">▸ TOP ROUTES</div>
                    {stats.top_routes.map(({ route, count }) => {
                        const [dep, arr] = route.split('-');
                        return (
                            <div key={route} className="mfp-dash-bar-row">
                                <span className="mfp-dash-bar-label route-label">
                                    {dep} <span className="mfp-dash-arrow">→</span> {arr}
                                </span>
                                <div className="mfp-dash-bar-track">
                                    <div className="mfp-dash-bar-fill" style={{ width: `${(count / maxRt) * 100}%` }} />
                                </div>
                                <span className="mfp-dash-bar-count">{count}</span>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* 最近 5 筆 */}
            {stats.recent?.length > 0 && (
                <div className="mfp-dash-section">
                    <div className="mfp-dash-section-title">▸ RECENT FLIGHTS</div>
                    {stats.recent.map(f => (
                        <div key={f.id} className="mfp-dash-recent-row">
                            <span className="mfp-iata small">{f.dep_icao || '??'}</span>
                            <Plane size={9} style={{ opacity: 0.5 }} />
                            <span className="mfp-iata small">{f.arr_icao || '??'}</span>
                            {f.flight_number && <span className="mfp-tag small">{f.flight_number}</span>}
                            <span className="mfp-date small">{f.flight_date}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── 子元件：航班列表行 ────────────────────────────────────────────────────────
function FlightRow({ flight, onEdit, onDelete }) {
    return (
        <div className="mfp-row">
            <div className="mfp-row-main">
                <div className="mfp-row-route">
                    <span className="mfp-iata">{flight.dep_icao || '????'}</span>
                    <div className="mfp-route-line">
                        <div className="mfp-route-dash" />
                        <Plane size={11} />
                        <div className="mfp-route-dash" />
                    </div>
                    <span className="mfp-iata">{flight.arr_icao || '????'}</span>
                </div>
                <div className="mfp-row-meta">
                    {flight.flight_number && <span className="mfp-tag fnum">{flight.flight_number}</span>}
                    {flight.aircraft_type && <span className="mfp-tag">{flight.aircraft_type}</span>}
                    {flight.seat_class    && <span className="mfp-tag">{flight.seat_class}</span>}
                    {flight.seat_number   && <span className="mfp-tag seat">STA {flight.seat_number}</span>}
                </div>
            </div>
            <div className="mfp-row-right">
                <span className="mfp-date">{flight.flight_date}</span>
                <button className="mfp-icon-btn" onClick={() => onEdit(flight)} title="編輯"><Pencil size={13} /></button>
                <button className="mfp-icon-btn danger" onClick={() => onDelete(flight.id)} title="刪除"><Trash2 size={13} /></button>
            </div>
        </div>
    );
}

// ── 子元件：新增 / 編輯表單 ────────────────────────────────────────────────────
function FlightForm({ initial, prefill, onSave, onCancel }) {
    const [form, setForm] = useState(() => ({
        ...EMPTY_FORM,
        ...(initial || {}),
        ...(prefill  || {}),
    }));
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState('');

    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

    async function handleSubmit(e) {
        e.preventDefault();
        if (!form.flight_date) { setError('請填寫日期'); return; }
        setLoading(true); setError('');
        try {
            // 清掉空字串
            const payload = Object.fromEntries(
                Object.entries(form).filter(([, v]) => v !== '')
            );
            await onSave(payload);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    return (
        <form className="mfp-form" onSubmit={handleSubmit}>

            {/* ROUTE */}
            <div className="mfp-form-section">
                <div className="mfp-form-section-label">▸ FLIGHT ROUTING</div>
                <div className="mfp-form-2col">
                    <div className="mfp-form-row">
                        <label>DEP ICAO *</label>
                        <input placeholder="RCTP" maxLength={4} value={form.dep_icao} onChange={e => set('dep_icao', e.target.value.toUpperCase())} />
                    </div>
                    <div className="mfp-form-row">
                        <label>ARR ICAO *</label>
                        <input placeholder="VHHH" maxLength={4} value={form.arr_icao} onChange={e => set('arr_icao', e.target.value.toUpperCase())} />
                    </div>
                </div>
                <div className="mfp-form-2col" style={{ marginTop: 10 }}>
                    <div className="mfp-form-row">
                        <label>FLIGHT DATE *</label>
                        <input type="date" value={form.flight_date} onChange={e => set('flight_date', e.target.value)} required />
                    </div>
                    <div className="mfp-form-row">
                        <label>FLIGHT NO.</label>
                        <input placeholder="CI101" value={form.flight_number} onChange={e => set('flight_number', e.target.value.toUpperCase())} />
                    </div>
                </div>
            </div>

            {/* AIRCRAFT */}
            <div className="mfp-form-section">
                <div className="mfp-form-section-label">▸ AIRCRAFT</div>
                <div className="mfp-form-2col">
                    <div className="mfp-form-row">
                        <label>TYPE</label>
                        <input placeholder="A333 / B789" value={form.aircraft_type} onChange={e => set('aircraft_type', e.target.value.toUpperCase())} />
                    </div>
                    <div className="mfp-form-row">
                        <label>REGISTRATION</label>
                        <input placeholder="B-18805" value={form.registration} onChange={e => set('registration', e.target.value.toUpperCase())} />
                    </div>
                </div>
                {form.icao24 && (
                    <div className="mfp-form-row" style={{ marginTop: 10 }}>
                        <label>ICAO24 HEX</label>
                        <input value={form.icao24} readOnly className="readonly" />
                    </div>
                )}
            </div>

            {/* TIMES */}
            <div className="mfp-form-section">
                <div className="mfp-form-section-label">▸ SCHEDULE</div>
                <div className="mfp-form-2col">
                    <div className="mfp-form-row">
                        <label>STD (DEP)</label>
                        <input type="time" value={form.dep_time} onChange={e => set('dep_time', e.target.value)} />
                    </div>
                    <div className="mfp-form-row">
                        <label>STA (ARR)</label>
                        <input type="time" value={form.arr_time} onChange={e => set('arr_time', e.target.value)} />
                    </div>
                </div>
            </div>

            {/* SEAT */}
            <div className="mfp-form-section">
                <div className="mfp-form-section-label">▸ CABIN / SEAT</div>
                <div className="mfp-form-2col">
                    <div className="mfp-form-row">
                        <label>SEAT NO.</label>
                        <input placeholder="32A" value={form.seat_number} onChange={e => set('seat_number', e.target.value)} />
                    </div>
                    <div className="mfp-form-row">
                        <label>CLASS</label>
                        <select value={form.seat_class} onChange={e => set('seat_class', e.target.value)}>
                            <option value="">—</option>
                            {SEAT_CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                    </div>
                </div>
                <div className="mfp-form-row" style={{ marginTop: 10 }}>
                    <label>REMARKS / NOTES</label>
                    <textarea placeholder="Window seat, turbulence, delay..." rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
                </div>
            </div>

            {error && <div className="mfp-form-error"><AlertCircle size={11} /> {error.toUpperCase()}</div>}

            <div className="mfp-form-actions">
                <button type="button" className="mfp-btn ghost" onClick={onCancel}>CANCEL</button>
                <button type="submit" className="mfp-btn primary" disabled={loading}>
                    {loading ? '● SAVING...' : initial?.id ? '▶ UPDATE LOG' : '▶ LOG FLIGHT'}
                </button>
            </div>
        </form>
    );
}

// ── 主元件 ────────────────────────────────────────────────────────────────────
export default function MyFlightsPanel({ onClose, prefillFromPlane }) {
    const [view, setView]         = useState('list');   // 'list' | 'form' | 'stats'
    const [flights, setFlights]   = useState([]);
    const [total, setTotal]       = useState(0);
    const [page, setPage]         = useState(1);
    const [stats, setStats]       = useState(null);
    const [editTarget, setEditTarget] = useState(null); // flight obj or null
    const [loading, setLoading]   = useState(false);
    const [toast, setToast]       = useState('');
    const LIMIT = 20;

    const showToast = (msg) => {
        setToast(msg);
        setTimeout(() => setToast(''), 2500);
    };

    const loadFlights = useCallback(async (p = 1) => {
        setLoading(true);
        try {
            const data = await apiListFlights(p, LIMIT);
            setFlights(data.flights);
            setTotal(data.total);
            setPage(p);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    }, []);

    const loadStats = useCallback(async () => {
        try {
            const s = await apiFlightStats();
            setStats(s);
        } catch (_) {}
    }, []);

    useEffect(() => {
        loadFlights(1);
        loadStats();
    }, [loadFlights, loadStats]);

    async function handleSave(payload) {
        if (editTarget?.id) {
            await apiUpdateFlight(editTarget.id, payload);
            showToast('已更新');
        } else {
            await apiCreateFlight(payload);
            showToast('已新增');
        }
        setView('list');
        setEditTarget(null);
        loadFlights(page);
        loadStats();
    }

    async function handleDelete(id) {
        if (!window.confirm('確定刪除這筆航班記錄？')) return;
        await apiDeleteFlight(id);
        showToast('已刪除');
        loadFlights(page);
        loadStats();
    }

    const totalPages = Math.max(1, Math.ceil(total / LIMIT));

    return (
        <div className="mfp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="mfp-panel">
                {/* Header */}
                <div className="mfp-header">
                    <div className="mfp-header-title">
                        <span className="mfp-header-eyebrow">AEROSTRAT / PERSONAL RECORD</span>
                        <div className="mfp-header-name">
                            <Plane size={15} />
                            FLIGHT LOG
                            <span className="mfp-count">{total} SECTORS</span>
                        </div>
                    </div>
                    <div className="mfp-header-actions">
                        {view === 'list' && (
                            <button className="mfp-btn primary small" onClick={() => { setEditTarget(null); setView('form'); }}>
                                <Plus size={11} /> LOG FLIGHT
                            </button>
                        )}
                        <button className="mfp-close" onClick={onClose}><X size={14} /></button>
                    </div>
                </div>

                {/* Stats bar */}
                {view === 'list' && <StatsBar stats={stats} onShowStats={() => setView('stats')} />}

                {/* 智慧帶入提示 */}
                {view === 'list' && prefillFromPlane && (
                    <div className="mfp-prefill-hint" onClick={() => { setEditTarget(null); setView('form'); }}>
                        <CheckCircle size={13} />
                        點此記錄當前選取的飛機 <strong>{prefillFromPlane.callsign || prefillFromPlane.icao24}</strong>
                    </div>
                )}

                {/* Content */}
                {view === 'stats' ? (
                    <div className="mfp-form-wrapper">
                        <StatsDashboard stats={stats} onBack={() => setView('list')} />
                    </div>
                ) : view === 'list' ? (
                    <div className="mfp-list-wrapper">
                        {loading && <div className="mfp-loading">載入中…</div>}
                        {!loading && flights.length === 0 && (
                            <div className="mfp-empty">
                                <Plane size={28} style={{ opacity: 0.4 }} />
                                <p>NO FLIGHT RECORDS FOUND</p>
                                <button className="mfp-btn primary" onClick={() => setView('form')}>▶ LOG FIRST FLIGHT</button>
                            </div>
                        )}
                        {flights.map(f => (
                            <FlightRow
                                key={f.id}
                                flight={f}
                                onEdit={(fl) => { setEditTarget(fl); setView('form'); }}
                                onDelete={handleDelete}
                            />
                        ))}

                        {/* Pagination */}
                        {totalPages > 1 && (
                            <div className="mfp-pagination">
                                <button
                                    className="mfp-icon-btn"
                                    disabled={page <= 1}
                                    onClick={() => loadFlights(page - 1)}
                                ><ChevronLeft size={14} /></button>
                                <span>{page} / {totalPages}</span>
                                <button
                                    className="mfp-icon-btn"
                                    disabled={page >= totalPages}
                                    onClick={() => loadFlights(page + 1)}
                                ><ChevronRight size={14} /></button>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="mfp-form-wrapper">
                        <FlightForm
                            initial={editTarget}
                            prefill={!editTarget && prefillFromPlane ? prefillFromPlane : undefined}
                            onSave={handleSave}
                            onCancel={() => { setView('list'); setEditTarget(null); }}
                        />
                    </div>
                )}

                {/* Toast */}
                {toast && <div className="mfp-toast"><CheckCircle size={11} /> {toast.toUpperCase()}</div>}
            </div>
        </div>
    );
}
