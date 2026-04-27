import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    X, Plus, Pencil, Trash2, Plane, MapPin, Calendar,
    ChevronLeft, ChevronRight, AlertCircle, CheckCircle, BarChart2, Loader
} from 'lucide-react';
import {
    apiListFlights, apiCreateFlight, apiUpdateFlight,
    apiDeleteFlight, apiFlightStats, apiLookupCallsign, apiLookupAirport,
    authStore,
} from '../store/authStore';
import './MyFlightsPanel.css';

// ── 登機證條碼裝飾（固定，不用 random）────────────────────────────────────────
const BARCODE = [18,10,24,12,20,28,8,18,22,14,20,10,26,18,14,22,10,20,16,18,24,8,20,18,22,16,12,26,10,18,20,22,16,24,12,18,20,26,14,22,10,18,24,12,20,16,28,8,18,22,14,20,26,12,18,16,24,10,22,28];

// ── 空白表單 ──────────────────────────────────────────────────────────────────
function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

const EMPTY_FORM = {
    flight_date: todayStr(), flight_number: '', callsign: '', icao24: '',
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

// ── 子元件：航班列表行（登機證卡片 v3）───────────────────────────────────────
function FlightRow({ flight, onEdit, onDelete }) {
    const classMap = {
        '頭等艙': 'FIRST', '商務艙': 'BUSINESS', '豪華經濟艙': 'PREM ECO', '經濟艙': 'ECONOMY',
        'first': 'FIRST', 'business': 'BUSINESS', 'premium_economy': 'PREM ECO', 'economy': 'ECONOMY',
    };
    const classLabel = classMap[flight.seat_class] || (flight.seat_class ? flight.seat_class.toUpperCase() : null);
    const hasDetails = flight.aircraft_type || classLabel || flight.seat_number || flight.registration;

    return (
        <div className="fhr-card">
            {/* ── Top bar: brand / flight / date / actions ── */}
            <div className="fhr-topbar">
                <div className="fhr-brand">
                    <Plane size={9} />
                    AEROSTRAT
                </div>
                {flight.flight_number && (
                    <div className="fhr-fn">{flight.flight_number}</div>
                )}
                <div className="fhr-date">{flight.flight_date}</div>
                <div className="fhr-actions">
                    <button className="fhr-btn" onClick={() => onEdit(flight)}>
                        <Pencil size={11} /> EDIT
                    </button>
                    <button className="fhr-btn fhr-btn-danger" onClick={() => onDelete(flight.id)}>
                        <Trash2 size={11} />
                    </button>
                </div>
            </div>

            {/* ── Route ── */}
            <div className="fhr-route">
                <div className="fhr-apt-block">
                    <div className="fhr-iata">{flight.dep_icao || '——'}</div>
                    {flight.dep_time && <div className="fhr-time">{flight.dep_time}</div>}
                </div>
                <div className="fhr-route-mid">
                    <div className="fhr-route-line">
                        <div className="fhr-rdot" />
                        <div className="fhr-rdash" />
                        <Plane size={16} style={{ transform: 'rotate(90deg)', color: '#c4a260', flexShrink: 0 }} />
                        <div className="fhr-rdash" />
                        <div className="fhr-rdot" />
                    </div>
                </div>
                <div className="fhr-apt-block fhr-apt-r">
                    <div className="fhr-iata">{flight.arr_icao || '——'}</div>
                    {flight.arr_time && <div className="fhr-time fhr-time-r">{flight.arr_time}</div>}
                </div>
            </div>

            {/* ── Detail strip (only if there is data) ── */}
            {hasDetails && (
                <div className="fhr-details">
                    {flight.aircraft_type && (
                        <div className="fhr-detail-item">
                            <div className="fhr-dl">A/C</div>
                            <div className="fhr-dv">{flight.aircraft_type}</div>
                        </div>
                    )}
                    {classLabel && (
                        <div className="fhr-detail-item">
                            <div className="fhr-dl">CLASS</div>
                            <div className="fhr-dv">{classLabel}</div>
                        </div>
                    )}
                    {flight.seat_number && (
                        <div className="fhr-detail-item">
                            <div className="fhr-dl">SEAT</div>
                            <div className="fhr-dv fhr-dv-seat">{flight.seat_number}</div>
                        </div>
                    )}
                    {flight.registration && (
                        <div className="fhr-detail-item">
                            <div className="fhr-dl">REG</div>
                            <div className="fhr-dv">{flight.registration}</div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Notes ── */}
            {flight.notes && (
                <div className="fhr-notes">{flight.notes}</div>
            )}
        </div>
    );
}

// ── 子元件：新增 / 編輯表單（登機證風格）──────────────────────────────────────
function FlightForm({ initial, prefill, onSave, onCancel }) {
    const [form, setForm] = useState(() => ({
        ...EMPTY_FORM,
        ...(initial || {}),
        ...(prefill  || {}),
        // editing: keep existing date; new: today
        flight_date: initial?.flight_date || prefill?.flight_date || todayStr(),
    }));
    const [loading, setLoading]   = useState(false);
    const [error, setError]       = useState('');
    const [csLooking, setCsLooking] = useState(false);  // callsign lookup spinner
    const [enriching, setEnriching] = useState(false);  // auto-enrich spinner
    const [depHint, setDepHint]   = useState('');
    const [arrHint, setArrHint]   = useState('');
    const csTimerRef = useRef(null);
    const enrichedRef = useRef(false);

    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

    // ── 自動補全：當有 icao24+callsign 時呼叫 complete-details ─────────────────
    useEffect(() => {
        if (enrichedRef.current) return;  // only once
        if (initial?.id) return;           // 編輯模式不自動填
        const hex = prefill?.icao24;
        const cs  = prefill?.callsign;
        if (!hex || !cs) return;
        enrichedRef.current = true;
        setEnriching(true);
        fetch(`/api/flight/complete-details/${encodeURIComponent(hex)}/${encodeURIComponent(cs)}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data) return;
                setForm(f => ({
                    ...f,
                    dep_icao:      f.dep_icao      || data.route?.origin_icao      || '',
                    arr_icao:      f.arr_icao      || data.route?.destination_icao || '',
                    dep_time:      f.dep_time      || data.route?.departure_time   || '',
                    arr_time:      f.arr_time      || data.route?.arrival_time     || '',
                    aircraft_type: f.aircraft_type || data.aircraft?.type          || '',
                    registration:  f.registration  || data.aircraft?.registration  || '',
                }));
                if (data.route?.origin_name)      setDepHint(data.route.origin_name);
                if (data.route?.destination_name) setArrHint(data.route.destination_name);
            })
            .catch(() => {})
            .finally(() => setEnriching(false));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── 航班號自動查詢（debounce 600ms）────────────────────────────────────────
    function handleFlightNumberChange(val) {
        set('flight_number', val);
        if (csTimerRef.current) clearTimeout(csTimerRef.current);
        const cs = val.toUpperCase().trim();
        if (cs.length < 3) return;
        csTimerRef.current = setTimeout(async () => {
            setCsLooking(true);
            const r = await apiLookupCallsign(cs);
            setCsLooking(false);
            if (!r.found) return;
            setForm(f => ({
                ...f,
                dep_icao: f.dep_icao || r.dep_iata || '',
                arr_icao: f.arr_icao || r.arr_iata || '',
                dep_time: f.dep_time || r.dep_time || '',
                arr_time: f.arr_time || r.arr_time || '',
                callsign: f.callsign || cs || '',
            }));
            if (r.dep_name) setDepHint(r.dep_name);
            if (r.arr_name) setArrHint(r.arr_name);
        }, 600);
    }

    // ── 機場代碼查詢（輸入滿 3 碼 IATA 或 4 碼 ICAO）─────────────────────────
    async function handleAirportBlur(field, val) {
        const code = val.toUpperCase().trim();
        if (code.length < 3 || code.length > 4) return;
        const r = await apiLookupAirport(code);
        if (!r.found) return;
        if (field === 'dep') setDepHint(r.name);
        if (field === 'arr') setArrHint(r.name);
    }

    async function handleSubmit(e) {
        e.preventDefault();
        if (!form.flight_date) { setError('FLIGHT DATE REQUIRED'); return; }
        setLoading(true); setError('');
        try {
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

    // ── 共用欄位 JSX ────────────────────────────────────────────────────────────
    const routeSection = (
        <>
            <div className="bpf-hcard-apt">
                <div className="bpf-apt-lbl">FROM</div>
                <input className="bpf-h-iata" placeholder="TPE" maxLength={4}
                    value={form.dep_icao}
                    onChange={e => { set('dep_icao', e.target.value.toUpperCase()); setDepHint(''); }}
                    onBlur={e => handleAirportBlur('dep', e.target.value)} />
                {depHint
                    ? <div className="bpf-apt-hint">{depHint}</div>
                    : <input type="time" className="bpf-h-time" value={form.dep_time} onChange={e => set('dep_time', e.target.value)} />}
            </div>
            <div className="bpf-hcard-route-mid">
                <div className="bpf-route-vis">
                    <div className="bpf-rdot" />
                    <div className="bpf-rdash" />
                    <Plane size={16} style={{ transform: 'rotate(90deg)', color: 'rgba(26,39,68,0.35)', flexShrink: 0 }} />
                    <div className="bpf-rdash" />
                    <div className="bpf-rdot" />
                </div>
                <div className="bpf-flt-wrap">
                    <input className="bpf-flt" placeholder="CI101"
                        value={form.flight_number}
                        onChange={e => handleFlightNumberChange(e.target.value)} />
                    {csLooking && <Loader size={10} className="bpf-spin" />}
                </div>
            </div>
            <div className="bpf-hcard-apt bpf-hcard-apt-r">
                <div className="bpf-apt-lbl bpf-apt-lbl-r">TO</div>
                <input className="bpf-h-iata bpf-h-iata-r" placeholder="HKG" maxLength={4}
                    value={form.arr_icao}
                    onChange={e => { set('arr_icao', e.target.value.toUpperCase()); setArrHint(''); }}
                    onBlur={e => handleAirportBlur('arr', e.target.value)} />
                {arrHint
                    ? <div className="bpf-apt-hint bpf-apt-hint-r">{arrHint}</div>
                    : <input type="time" className="bpf-h-time bpf-h-time-r" value={form.arr_time} onChange={e => set('arr_time', e.target.value)} />}
            </div>
        </>
    );

    const detailsGrid = (
        <div className="bpf-grid">
            <div className="bpf-cell">
                <div className="bpf-cl">DATE</div>
                <input type="date" className="bpf-cv" required value={form.flight_date} onChange={e => set('flight_date', e.target.value)} />
            </div>
            <div className="bpf-cell">
                <div className="bpf-cl">AIRCRAFT</div>
                <input className="bpf-cv" placeholder="A333" value={form.aircraft_type} onChange={e => set('aircraft_type', e.target.value.toUpperCase())} />
            </div>
            <div className="bpf-cell bpf-cell-end">
                <div className="bpf-cl">CLASS</div>
                <select className="bpf-cv" value={form.seat_class} onChange={e => set('seat_class', e.target.value)}>
                    <option value="">—</option>
                    {SEAT_CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
            </div>
            <div className="bpf-cell bpf-cell-r2">
                <div className="bpf-cl">REGISTRATION</div>
                <input className="bpf-cv" placeholder="B-18805" value={form.registration} onChange={e => set('registration', e.target.value.toUpperCase())} />
            </div>
            <div className="bpf-cell bpf-cell-r2">
                <div className="bpf-cl">SEAT</div>
                <input className="bpf-cv" placeholder="32A" value={form.seat_number} onChange={e => set('seat_number', e.target.value)} />
            </div>
            <div className="bpf-cell bpf-cell-r2 bpf-cell-end">
                <div className="bpf-cl">CALLSIGN</div>
                <input className="bpf-cv" placeholder="CI101" value={form.callsign} onChange={e => set('callsign', e.target.value.toUpperCase())} />
            </div>
        </div>
    );

    const passengerName = authStore.getUser?.()?.username?.toUpperCase() || '—';

    const headerBlock = (
        <div className="bpf-header">
            <div className="bpf-logo">
                <Plane size={18} />
                <div>
                    <div className="bpf-logo-name">AEROSTRAT</div>
                    <div className="bpf-logo-sub">FLIGHT RECORD</div>
                </div>
            </div>
            <div className="bpf-header-right">
                {enriching && (
                    <span className="bpf-enrich-badge">
                        <Loader size={9} className="bpf-spin" /> AUTO-FILL
                    </span>
                )}
                <span className="bpf-bp-label">BOARDING PASS</span>
            </div>
        </div>
    );

    const passengerRow = (
        <div className="bpf-passenger-row">
            <div className="bpf-passenger-col">
                <div className="bpf-passenger-label">PASSENGER NAME</div>
                <div className="bpf-passenger-name">{passengerName}</div>
            </div>
            <div className="bpf-passenger-col bpf-passenger-col-r">
                <div className="bpf-passenger-label">FLIGHT DATE</div>
                <div className="bpf-passenger-date">{form.flight_date || '—'}</div>
            </div>
        </div>
    );

    // ── 橫向登機證（全頁模式） ─────────────────────────────────────────────────
    return (
        <div className="bpf-hwrapper">
            <form className="bpf-hcard" onSubmit={handleSubmit}>

                {/* ── Main section ── */}
                <div className="bpf-hcard-main">
                    {headerBlock}
                    {passengerRow}
                    <div className="bpf-hcard-body">
                        <div className="bpf-hcard-route">{routeSection}</div>
                        <div className="bpf-hcard-vdivider" />
                        <div className="bpf-hcard-details">{detailsGrid}</div>
                    </div>
                </div>

                {/* ── Vertical tear ── */}
                <div className="bpf-htear">
                    <div className="bpf-htear-line" />
                </div>

                {/* ── Stub ── */}
                <div className="bpf-hstub">
                    <div className="bpf-stub-summary">
                        <div className="bpf-stub-row">
                            <div className="bpf-cl">FLIGHT</div>
                            <div className="bpf-stub-val">{form.flight_number || '—'}</div>
                        </div>
                        <div className="bpf-stub-row">
                            <div className="bpf-cl">SEAT</div>
                            <div className="bpf-stub-val bpf-stub-seat">{form.seat_number || '—'}</div>
                        </div>
                        <div className="bpf-stub-row">
                            <div className="bpf-cl">CLASS</div>
                            <div className="bpf-stub-val">{form.seat_class || '—'}</div>
                        </div>
                    </div>
                    <div className="bpf-stub-divider" />
                    <div className="bpf-stub-field">
                        <div className="bpf-cl">REMARKS</div>
                        <textarea className="bpf-notes bpf-notes-h" placeholder="Window seat, delay, turbulence..."
                            rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} />
                    </div>
                    {error && (
                        <div className="bpf-error"><AlertCircle size={11} /> {error}</div>
                    )}
                    <div className="bpf-actions">
                        <button type="button" className="bpf-btn bpf-cancel" onClick={onCancel}>CANCEL</button>
                        <button type="submit" className="bpf-btn bpf-submit" disabled={loading}>
                            {loading ? '● SAVING...' : initial?.id ? '▶ UPDATE' : '▶ LOG FLIGHT'}
                        </button>
                    </div>
                    <div className="bpf-barcode" aria-hidden="true">
                        {BARCODE.map((h, i) => <span key={i} style={{ height: h + 'px' }} />)}
                    </div>
                </div>

            </form>
        </div>
    );
}

// ── 主元件 ────────────────────────────────────────────────────────────────────
// mode: 'modal' (預設，overlay 彈窗) | 'page' (全頁，取代主畫面)
export default function MyFlightsPanel({ onClose, prefillFromPlane, initialView = 'list', mode = 'modal' }) {
    const [view, setView]         = useState(initialView);   // 'list' | 'form' | 'stats'
    const [formFromList, setFormFromList] = useState(initialView !== 'form'); // true = navigated from list
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

    // ── 表單全頁（優先渲染，覆蓋整個畫面）───────────────────────────────────────
    if (view === 'form') {
        return (
            <>
                <div className="mfp-form-fullpage">
                    <div className="mfp-form-fullpage-bar">
                        <button className="mfp-form-fullpage-back"
                            onClick={() => { setView('list'); setEditTarget(null); }}>
                            <ChevronLeft size={15} /> BACK
                        </button>
                        <div className="mfp-form-fullpage-title">
                            <Plane size={13} />
                            {editTarget ? 'EDIT FLIGHT' : 'LOG FLIGHT'}
                        </div>
                        <div className="mfp-form-fullpage-spacer" />
                    </div>
                    <div className="mfp-form-fullpage-body">
                        <FlightForm
                            initial={editTarget}
                            prefill={!editTarget && prefillFromPlane ? prefillFromPlane : undefined}
                            onSave={handleSave}
                            onCancel={() => {
                                if (formFromList) { setView('list'); setEditTarget(null); }
                                else { onClose(); }
                            }}
                        />
                    </div>
                </div>
                {toast && <div className="mfp-toast"><CheckCircle size={11} /> {toast.toUpperCase()}</div>}
            </>
        );
    }

    // ── 共用內容區（list / stats）────────────────────────────────────────────────
    const content = (
        <>
            {/* Stats bar */}
            {view === 'list' && <StatsBar stats={stats} onShowStats={() => setView('stats')} />}

            {/* 智慧帶入提示 */}
            {view === 'list' && prefillFromPlane && (
                <div className="mfp-prefill-hint" onClick={() => { setEditTarget(null); setFormFromList(true); setView('form'); }}>
                    <CheckCircle size={13} />
                    點此記錄當前選取的飛機 <strong>{prefillFromPlane.callsign || prefillFromPlane.icao24}</strong>
                </div>
            )}

            {view === 'stats' ? (
                <div className="mfp-form-wrapper">
                    <StatsDashboard stats={stats} onBack={() => setView('list')} />
                </div>
            ) : (
                <div className="mfp-list-wrapper">
                    {loading && <div className="mfp-loading">載入中…</div>}
                    {!loading && flights.length === 0 && (
                        <div className="mfp-empty">
                            <Plane size={28} style={{ opacity: 0.4 }} />
                            <p>NO FLIGHT RECORDS FOUND</p>
                            <button className="mfp-btn primary" onClick={() => { setFormFromList(true); setView('form'); }}>▶ LOG FIRST FLIGHT</button>
                        </div>
                    )}
                    {flights.map(f => (
                        <FlightRow
                            key={f.id}
                            flight={f}
                            onEdit={(fl) => { setEditTarget(fl); setFormFromList(true); setView('form'); }}
                            onDelete={handleDelete}
                        />
                    ))}
                    {totalPages > 1 && (
                        <div className="mfp-pagination">
                            <button className="mfp-icon-btn" disabled={page <= 1} onClick={() => loadFlights(page - 1)}><ChevronLeft size={14} /></button>
                            <span>{page} / {totalPages}</span>
                            <button className="mfp-icon-btn" disabled={page >= totalPages} onClick={() => loadFlights(page + 1)}><ChevronRight size={14} /></button>
                        </div>
                    )}
                </div>
            )}

            {toast && <div className="mfp-toast"><CheckCircle size={11} /> {toast.toUpperCase()}</div>}
        </>
    );

    // ── 全頁模式（歷史紀錄頁）────────────────────────────────────────────────────
    if (mode === 'page') {
        return (
            <div className="mfp-page">
                {/* Page top bar */}
                <div className="mfp-page-bar">
                    <button className="mfp-page-back" onClick={onClose}>
                        <ChevronLeft size={16} /> 返回地圖
                    </button>
                    <div className="mfp-page-title">
                        <Plane size={14} />
                        <span>FLIGHT LOG</span>
                        <span className="mfp-count">{total} SECTORS</span>
                    </div>
                    <div className="mfp-page-actions">
                        {view === 'list' && (
                            <button className="mfp-btn primary small" onClick={() => { setEditTarget(null); setFormFromList(true); setView('form'); }}>
                                <Plus size={11} /> LOG FLIGHT
                            </button>
                        )}
                        {view !== 'list' && (
                            <button className="mfp-btn ghost small" onClick={() => { setView('list'); setEditTarget(null); }}>
                                ← 記錄列表
                            </button>
                        )}
                    </div>
                </div>

                {/* Page content */}
                <div className="mfp-page-body">
                    <div className="mfp-page-inner">
                        {content}
                    </div>
                </div>
            </div>
        );
    }

    // ── Modal 模式（預設，overlay 彈窗）─────────────────────────────────────────
    return (
        <div className="mfp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="mfp-panel">
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
                            <button className="mfp-btn primary small" onClick={() => { setEditTarget(null); setFormFromList(true); setView('form'); }}>
                                <Plus size={11} /> LOG FLIGHT
                            </button>
                        )}
                        <button className="mfp-close" onClick={onClose}><X size={14} /></button>
                    </div>
                </div>
                {content}
            </div>
        </div>
    );
}
