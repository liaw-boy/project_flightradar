import React, { useState, useEffect, useCallback, useRef } from 'react';
import AeroIcon from './AeroIcon';
import {
    X, Plus, Pencil, Trash2, Plane,
    ChevronLeft, ChevronRight, AlertCircle, CheckCircle, Loader, ArrowRight, CalendarDays
} from 'lucide-react';
import {
    apiListFlights, apiCreateFlight, apiUpdateFlight,
    apiDeleteFlight, apiFlightStats, apiLookupCallsign, apiLookupAirport,
    authStore,
} from '../store/authStore';
import ConfirmDialog from './ConfirmDialog';
import './MyFlightsPanel.css';

const BARCODE = [18,10,24,12,20,28,8,18,22,14,20,10,26,18,14,22,10,20,16,18,24,8,20,18,22,16,12,26,10,18,20,22,16,24,12,18,20,26,14,22,10,18,24,12,20,16,28,8,18,22,14,20,26,12,18,16,24,10,22,28];

function todayStr() { return new Date().toISOString().slice(0, 10); }

const EMPTY_FORM = {
    flight_date: todayStr(), flight_number: '', callsign: '', icao24: '',
    aircraft_type: '', registration: '', dep_icao: '', arr_icao: '',
    dep_time: '', arr_time: '', seat_number: '', seat_class: '', notes: '',
};
const SEAT_CLASSES = [
    { value: 'economy',         label: '經濟艙' },
    { value: 'premium_economy', label: '豪華經濟艙' },
    { value: 'business',        label: '商務艙' },
    { value: 'first',           label: '頭等艙' },
];
const CLASS_MAP = {
    '頭等艙': 'FIRST', '商務艙': 'BUSINESS', '豪華經濟艙': 'PREM ECO', '經濟艙': 'ECONOMY',
    'first': 'FIRST', 'business': 'BUSINESS', 'premium_economy': 'PREM ECO', 'economy': 'ECONOMY',
};

// ── 統計儀表板 ────────────────────────────────────────────────────────────────
function StatsDashboard({ stats, onBack }) {
    if (!stats) return null;
    const maxAc = stats.top_aircraft?.[0]?.count || 1;
    const maxRt = stats.top_routes?.[0]?.count || 1;
    return (
        <div className="sd-wrap">
            <button className="sd-back" onClick={onBack}>
                <ChevronLeft size={16} /> 返回航班記錄
            </button>
            <h1 className="sd-hero">FLIGHT<br /><span className="sd-hero-gold">METRICS</span></h1>

            {/* Big 3 cards */}
            <div className="sd-summary">
                <div className="sd-card">
                    <span className="sd-card-num">01</span>
                    <div className="sd-card-label">Sectors flown</div>
                    <div className="sd-card-big">{stats.total_flights ?? '—'}</div>
                </div>
                <div className="sd-card">
                    <span className="sd-card-num">02</span>
                    <div className="sd-card-label">Distance · km</div>
                    <div className="sd-card-big">
                        {stats.total_km >= 1000 ? `${(stats.total_km / 1000).toFixed(1)}k` : (stats.total_km ?? '—')}
                    </div>
                </div>
                <div className="sd-card">
                    <span className="sd-card-num">03</span>
                    <div className="sd-card-label">Airports visited</div>
                    <div className="sd-card-big">{stats.total_airports ?? '—'}</div>
                </div>
            </div>

            <div className="sd-grid">
                <div className="sd-col">
                    {stats.top_aircraft?.length > 0 && (
                        <section className="sd-section">
                            <div className="sd-section-title">Top aircraft types</div>
                            {stats.top_aircraft.map(({ type, count }) => (
                                <div key={type} className="sd-bar-row">
                                    <div className="sd-bar-label">{type}</div>
                                    <div className="sd-bar-track">
                                        <div className="sd-bar-fill" style={{ width: `${(count / maxAc) * 100}%` }} />
                                    </div>
                                    <div className="sd-bar-count">{count}</div>
                                </div>
                            ))}
                        </section>
                    )}
                    {stats.top_routes?.length > 0 && (
                        <section className="sd-section">
                            <div className="sd-section-title">Top routes</div>
                            {stats.top_routes.map(({ route, count }) => {
                                const [dep, arr] = route.split('-');
                                return (
                                    <div key={route} className="sd-bar-row sd-route-row">
                                        <div className="sd-bar-label">
                                            {dep} <ArrowRight size={10} className="sd-arrow" /> {arr}
                                        </div>
                                        <div className="sd-bar-track">
                                            <div className="sd-bar-fill" style={{ width: `${(count / maxRt) * 100}%` }} />
                                        </div>
                                        <div className="sd-bar-count">{count}</div>
                                    </div>
                                );
                            })}
                        </section>
                    )}
                </div>

                {stats.recent?.length > 0 && (
                    <div className="sd-col">
                        <section className="sd-section">
                            <div className="sd-section-title">Recent flights</div>
                            <div className="sd-recent-list">
                                {stats.recent.map(f => (
                                    <div key={f.id} className="sd-recent-row">
                                        <div className="sd-recent-route">
                                            <span className="sd-recent-iata">{f.dep_icao || '??'}</span>
                                            <Plane size={10} className="sd-recent-plane" />
                                            <span className="sd-recent-iata">{f.arr_icao || '??'}</span>
                                        </div>
                                        {f.flight_number && (
                                            <div className="sd-recent-tag">{f.flight_number}</div>
                                        )}
                                        <div className="sd-recent-date">{f.flight_date}</div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── 航班列表卡 v5 — vertical stack ────────────────────────────────────────────
function formatTime(str) {
    if (!str) return null;
    const m = String(str).match(/(\d{2}:\d{2})/);
    return m ? m[1] : null;
}

function FlightRow({ flight, onEdit, onDelete }) {
    const classLabel = CLASS_MAP[flight.seat_class] || (flight.seat_class ? flight.seat_class.toUpperCase() : null);
    const depTime = formatTime(flight.dep_time);
    const arrTime = formatTime(flight.arr_time);
    return (
        <div className="fc-card">
            <div className="fc-header">
                <span className="fc-brand">AEROSTRAT</span>
                <span className="fc-flight-meta">
                    {flight.flight_number && <span className="fc-fn">{flight.flight_number}</span>}
                    <span className="fc-date">{flight.flight_date}</span>
                </span>
            </div>

            <div className="fc-route">
                <div className="fc-airport">
                    <div className="fc-iata">{flight.dep_icao || '—'}</div>
                    {depTime && <div className="fc-time">{depTime}</div>}
                </div>
                <div className="fc-arrow">
                    <div className="fc-arrow-line" />
                    <Plane size={14} />
                    <div className="fc-arrow-line" />
                </div>
                <div className="fc-airport fc-airport--r">
                    <div className="fc-iata">{flight.arr_icao || '—'}</div>
                    {arrTime && <div className="fc-time">{arrTime}</div>}
                </div>
            </div>

            <div className="fc-sep" />

            <div className="fc-body">
                {(classLabel || flight.seat_number || flight.aircraft_type || flight.registration) && (
                    <div className="fc-chips">
                        {classLabel && <div className="fc-chip"><span className="fc-chip-label">Class</span><span className="fc-chip-value">{classLabel}</span></div>}
                        {flight.seat_number && <div className="fc-chip"><span className="fc-chip-label">Seat</span><span className="fc-chip-value">{flight.seat_number}</span></div>}
                        {flight.aircraft_type && <div className="fc-chip"><span className="fc-chip-label">Aircraft</span><span className="fc-chip-value">{flight.aircraft_type}</span></div>}
                        {flight.registration && <div className="fc-chip"><span className="fc-chip-label">Reg</span><span className="fc-chip-value">{flight.registration}</span></div>}
                    </div>
                )}
                {flight.notes && <div className="fc-notes">{flight.notes}</div>}
                <div className="fc-actions">
                    <button className="fc-btn" onClick={() => onEdit(flight)} title="Edit"><Pencil size={13} /></button>
                    <button className="fc-btn fc-btn--del" onClick={() => onDelete(flight.id)} title="Delete"><Trash2 size={13} /></button>
                </div>
            </div>
        </div>
    );
}

// ── 新增 / 編輯表單（橫向登機證 — Stitch design）────────────────────────────
function FlightForm({ initial, prefill, onSave, onCancel, pageMode = false }) {
    const [form, setForm] = useState(() => ({
        ...EMPTY_FORM,
        ...(initial || {}),
        ...(prefill || {}),
        flight_date: initial?.flight_date || prefill?.flight_date || todayStr(),
    }));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [csLooking, setCsLooking] = useState(false);
    const [enriching, setEnriching] = useState(false);
    const [depHint, setDepHint] = useState('');
    const [arrHint, setArrHint] = useState('');
    const [airlineHint, setAirlineHint] = useState('');
    const csTimerRef = useRef(null);
    const dateInputRef = useRef(null);

    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

    // Re-run when the selected plane changes (prefillKey tracks identity across renders)
    const prefillKey = `${prefill?.icao24}|${prefill?.callsign}`;
    useEffect(() => {
        if (initial?.id) return;
        const hex = prefill?.icao24;
        const cs = prefill?.callsign;
        if (!hex || !cs) return;
        let cancelled = false;
        setEnriching(true);
        fetch(`/api/flight/complete-details/${encodeURIComponent(hex)}/${encodeURIComponent(cs)}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (cancelled || !data) return;
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
            .finally(() => { if (!cancelled) setEnriching(false); });
        return () => { cancelled = true; };
    }, [prefillKey, initial?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    function handleFlightNumberChange(rawVal) {
        // Only allow letters + digits, uppercase, max 7 chars (e.g. IT211, CI1234A)
        const sanitized = rawVal.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
        set('flight_number', sanitized);
        if (csTimerRef.current) clearTimeout(csTimerRef.current);
        if (sanitized.length < 2) { setAirlineHint(''); return; }

        csTimerRef.current = setTimeout(async () => {
            // Lookup airline name from 2-letter prefix (e.g. IT → Tiger Air Taiwan)
            const prefix = sanitized.slice(0, 2);
            if (/^[A-Z]{2}$/.test(prefix)) {
                fetch(`/api/airline/${encodeURIComponent(sanitized)}`)
                    .then(r => r.ok ? r.json() : null)
                    .then(d => {
                        const name = d?.name || d?.airline?.name || '';
                        setAirlineHint(name);
                    })
                    .catch(() => {});
            }

            if (sanitized.length < 3) return;
            setCsLooking(true);
            setEnriching(true);
            const r = await apiLookupCallsign(sanitized);
            setCsLooking(false);
            setEnriching(false);
            if (!r.found && !r.registration && !r.typecode) return;
            setForm(f => ({
                ...f,
                dep_icao:      f.dep_icao      || r.dep_iata    || '',
                arr_icao:      f.arr_icao      || r.arr_iata    || '',
                dep_time:      f.dep_time      || r.dep_time    || '',
                arr_time:      f.arr_time      || r.arr_time    || '',
                callsign:      f.callsign      || sanitized     || '',
                registration:  f.registration  || r.registration || '',
                aircraft_type: f.aircraft_type || r.typecode    || '',
            }));
            if (r.dep_name) setDepHint(r.dep_name);
            if (r.arr_name) setArrHint(r.arr_name);
        }, 500);
    }

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
        if (!form.flight_date) { setError('Flight date is required'); return; }
        setLoading(true); setError('');
        try {
            const payload = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ''));
            await onSave(payload);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    const passengerName = authStore.getUser?.()?.username?.toUpperCase() || '—';

    const formContent = (
        <div className="bf-wrap">
            <form className="bf-card" onSubmit={handleSubmit}>

                {/* LEFT: main ticket */}
                <div className="bf-main">
                    {/* Header */}
                    <div className="bf-header">
                        <div className="bf-logo">
                            <AeroIcon size={22} bg={false} />
                            <span className="bf-logo-name">AEROSTRAT</span>
                        </div>
                        <div className="bf-header-right">
                            {enriching && (
                                <span className="bf-enrich">
                                    <Loader size={9} className="bf-spin" /> Auto-filling
                                </span>
                            )}
                            <span className="bf-bp-label">Boarding pass</span>
                        </div>
                    </div>

                    {/* Passenger row */}
                    <div className="bf-pax">
                        <div className="bf-pax-col">
                            <div className="bf-pax-lbl">Passenger</div>
                            <div className="bf-pax-name">{passengerName}</div>
                        </div>
                        <div className="bf-pax-col bf-pax-col-r">
                            <div className="bf-pax-lbl">Flight date</div>
                            <div className="bf-pax-date">{form.flight_date || '—'}</div>
                        </div>
                    </div>

                    {/* Route */}
                    <div className="bf-route">
                        <div className="bf-apt-col">
                            <div className="bf-apt-lbl">From</div>
                            <input
                                className="bf-iata"
                                placeholder="TPE"
                                maxLength={4}
                                value={form.dep_icao}
                                onChange={e => { set('dep_icao', e.target.value.toUpperCase()); setDepHint(''); }}
                                onBlur={e => handleAirportBlur('dep', e.target.value)}
                            />
                            {depHint && <div className="bf-apt-hint" title={depHint}>{depHint}</div>}
                            <input type="time" className="bf-time" value={form.dep_time} onChange={e => set('dep_time', e.target.value)} />
                        </div>
                        <div className="bf-route-mid">
                            <div className="bf-route-line-wrap">
                                <div className="bf-rdash" />
                                <div className="bf-rplane">
                                    <Plane size={22} style={{ transform: 'rotate(90deg)', color: '#c4a260' }} />
                                </div>
                                <div className="bf-rdash" />
                            </div>
                            <div className="bf-fn-wrap">
                                <input
                                    className="bf-fn"
                                    placeholder="IT211"
                                    maxLength={7}
                                    value={form.flight_number}
                                    onChange={e => handleFlightNumberChange(e.target.value)}
                                />
                                {csLooking && <Loader size={10} className="bf-spin" />}
                            </div>
                            {airlineHint && (
                                <div className="bf-airline-hint">{airlineHint}</div>
                            )}
                        </div>
                        <div className="bf-apt-col bf-apt-col-r">
                            <div className="bf-apt-lbl bf-apt-lbl-r">To</div>
                            <input
                                className="bf-iata bf-iata-r"
                                placeholder="HKG"
                                maxLength={4}
                                value={form.arr_icao}
                                onChange={e => { set('arr_icao', e.target.value.toUpperCase()); setArrHint(''); }}
                                onBlur={e => handleAirportBlur('arr', e.target.value)}
                            />
                            {arrHint && <div className="bf-apt-hint bf-apt-hint-r" title={arrHint}>{arrHint}</div>}
                            <input type="time" className="bf-time bf-time-r" value={form.arr_time} onChange={e => set('arr_time', e.target.value)} />
                        </div>
                    </div>

                    {/* 3×2 grid */}
                    <div className="bf-grid">
                        <div className="bf-cell">
                            <div className="bf-cl">Date</div>
                            <div className="bf-date-wrap">
                                <input
                                    ref={dateInputRef}
                                    type="date"
                                    className="bf-cv"
                                    required
                                    value={form.flight_date}
                                    onChange={e => set('flight_date', e.target.value)}
                                />
                                <button
                                    type="button"
                                    className="bf-date-icon"
                                    tabIndex={-1}
                                    onClick={() => dateInputRef.current?.showPicker?.()}
                                >
                                    <CalendarDays size={14} />
                                </button>
                            </div>
                        </div>
                        <div className="bf-cell">
                            <div className="bf-cl">Aircraft {enriching && <Loader size={9} className="bf-spin" style={{marginLeft:4}} />}</div>
                            <input className="bf-cv" placeholder={enriching ? '查詢中…' : 'A350'} value={form.aircraft_type} onChange={e => set('aircraft_type', e.target.value.toUpperCase())} />
                        </div>
                        <div className="bf-cell">
                            <div className="bf-cl">Class</div>
                            <select className="bf-cv" value={form.seat_class} onChange={e => set('seat_class', e.target.value)}>
                                <option value="">—</option>
                                {SEAT_CLASSES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                            </select>
                        </div>
                        <div className="bf-cell">
                            <div className="bf-cl">Registration {enriching && <Loader size={9} className="bf-spin" style={{marginLeft:4}} />}</div>
                            <input className="bf-cv" placeholder={enriching ? '查詢中…' : '選填 / 自動帶入'} value={form.registration} onChange={e => set('registration', e.target.value.toUpperCase())} />
                        </div>
                        <div className="bf-cell">
                            <div className="bf-cl">Seat</div>
                            <input className="bf-cv" placeholder="12A" value={form.seat_number} onChange={e => set('seat_number', e.target.value)} />
                        </div>
                        <div className="bf-cell">
                            <div className="bf-cl">Callsign</div>
                            <input className="bf-cv" placeholder="CI101" value={form.callsign} onChange={e => set('callsign', e.target.value.toUpperCase())} />
                        </div>
                    </div>
                </div>

                {/* VERTICAL TEAR */}
                <div className="bf-vtear">
                    <div className="bf-vnotch bf-vnotch-t" />
                    <div className="bf-vtear-line" />
                    <div className="bf-vnotch bf-vnotch-b" />
                </div>

                {/* RIGHT STUB */}
                <div className="bf-stub">
                    <div className="bf-stub-body">
                        <div className="bf-stub-row">
                            <div className="bf-cl">Flight</div>
                            <div className="bf-stub-val">{form.flight_number || '—'}</div>
                        </div>
                        <div className="bf-stub-seat-row">
                            <div>
                                <div className="bf-cl">Seat</div>
                                <div className="bf-stub-seat">{form.seat_number || '—'}</div>
                            </div>
                            <div className="bf-stub-class-col">
                                <div className="bf-cl">Class</div>
                                <div className="bf-stub-val">{CLASS_MAP[form.seat_class] || form.seat_class || '—'}</div>
                            </div>
                        </div>
                        <div className="bf-stub-divider" />
                        <div className="bf-cl" style={{ marginBottom: 6 }}>Notes</div>
                        <textarea
                            className="bf-notes"
                            placeholder="A few words about this flight…"
                            rows={4}
                            value={form.notes}
                            onChange={e => set('notes', e.target.value)}
                        />
                        {error && (
                            <div className="bf-error"><AlertCircle size={11} /> {error}</div>
                        )}
                    </div>
                    <div className="bf-stub-footer">
                        <button
                            type="submit"
                            className="bf-btn-submit"
                            disabled={loading}
                        >
                            {loading ? 'Saving…' : initial?.id ? 'Update flight' : 'Log this flight'}
                        </button>
                        <button type="button" className="bf-btn-cancel" onClick={onCancel}>Cancel</button>
                        <div className="bf-barcode" aria-hidden="true">
                            {BARCODE.map((h, i) => <span key={i} style={{ height: h + 'px' }} />)}
                        </div>
                    </div>
                </div>

            </form>
        </div>
    );

    if (pageMode) {
        return (
            <div className="mfp-fullpage">
                <div className="mfp-fp-bar">
                    <button className="mfp-fp-back" onClick={onCancel}>
                        <ChevronLeft size={15} /> 返回
                    </button>
                    <div className="mfp-fp-title">
                        <AeroIcon size={18} bg={true} />
                        AEROSTRAT · Flight Log
                    </div>
                    <div className="mfp-fp-spacer" />
                </div>
                <div className="mfp-fp-body">
                    {formContent}
                </div>
            </div>
        );
    }

    return formContent;
}

// ── 主元件 ────────────────────────────────────────────────────────────────────
export default function MyFlightsPanel({ onClose, prefillFromPlane, initialView = 'list', mode = 'modal' }) {
    const [view, setView]         = useState(initialView);
    const [flights, setFlights]   = useState([]);
    const [total, setTotal]       = useState(0);
    const [page, setPage]         = useState(1);
    const [stats, setStats]       = useState(null);
    const [editTarget, setEditTarget] = useState(null);
    const [loading, setLoading]   = useState(false);
    const [toast, setToast]       = useState('');
    const [deleteTarget, setDeleteTarget] = useState(null);
    const LIMIT = 20;

    const showToast = msg => { setToast(msg); setTimeout(() => setToast(''), 2500); };

    const loadFlights = useCallback(async (p = 1) => {
        setLoading(true);
        try {
            const data = await apiListFlights(p, LIMIT);
            setFlights(data.flights);
            setTotal(data.total);
            setPage(p);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    }, []);

    const loadStats = useCallback(async () => {
        try { setStats(await apiFlightStats()); } catch (_) {}
    }, []);

    useEffect(() => { loadFlights(1); loadStats(); }, [loadFlights, loadStats]);

    async function handleSave(payload) {
        if (editTarget?.id) { await apiUpdateFlight(editTarget.id, payload); showToast('已更新'); }
        else { await apiCreateFlight(payload); showToast('已新增'); }
        setView('list');
        setEditTarget(null);
        loadFlights(page);
        loadStats();
    }

    function confirmDelete() {
        console.log('[DELETE] confirmDelete called, deleteTarget=', deleteTarget);
        if (!deleteTarget) { console.warn('[DELETE] no deleteTarget, abort'); return; }
        const id = deleteTarget;
        setDeleteTarget(null);
        setFlights(prev => prev.filter(f => f.id !== id));
        setTotal(prev => Math.max(0, prev - 1));
        showToast('已刪除');
        apiDeleteFlight(id)
            .then(() => { console.log('[DELETE] API ok, id=', id); loadFlights(page); loadStats(); })
            .catch(e => {
                console.error('[DELETE] API failed:', e);
                showToast('刪除失敗，重新載入中…');
                loadFlights(page);
            });
    }

    const totalPages = Math.max(1, Math.ceil(total / LIMIT));
    const goBack = () => { setView('list'); setEditTarget(null); };

    // ── 全頁表單 ──────────────────────────────────────────────────────────────
    if (view === 'form') {
        if (mode === 'page') {
            return (
                <>
                    <FlightForm
                        initial={editTarget}
                        onSave={handleSave}
                        onCancel={onClose}
                        pageMode={true}
                    />
                    {toast && <div className="mfp-toast"><CheckCircle size={11} /> {toast}</div>}
                </>
            );
        }
        return (
            <>
                <div className="mfp-fullpage">
                    <div className="mfp-fp-bar">
                        <button className="mfp-fp-back" onClick={goBack}>
                            <ChevronLeft size={15} /> 返回
                        </button>
                        <div className="mfp-fp-title">
                            <Plane size={14} />
                            {editTarget ? 'Edit flight' : 'Log a flight'}
                        </div>
                        <div className="mfp-fp-spacer" />
                    </div>
                    <div className="mfp-fp-body">
                        <FlightForm
                            initial={editTarget}
                            onSave={handleSave}
                            onCancel={goBack}
                        />
                    </div>
                </div>
                {toast && <div className="mfp-toast"><CheckCircle size={11} /> {toast}</div>}
            </>
        );
    }

    // ── 共用：stats strip ────────────────────────────────────────────────────
    const statsStrip = (
        <div className="mfp-stats-strip" onClick={() => setView('stats')}>
            <div className="mfp-stat-cell">
                <div className="mfp-stat-label">Flights</div>
                <div className="mfp-stat-big">{stats?.total_flights ?? '—'}</div>
                <div className="mfp-stat-unit">sectors</div>
            </div>
            <div className="mfp-stat-cell">
                <div className="mfp-stat-label">Distance</div>
                <div className="mfp-stat-big">
                    {stats?.total_km != null
                        ? (stats.total_km >= 1000 ? `${(stats.total_km / 1000).toFixed(1)}k` : stats.total_km)
                        : '—'}
                </div>
                <div className="mfp-stat-unit">km</div>
            </div>
            <div className="mfp-stat-cell mfp-stat-cta">
                <div className="mfp-stat-label">Airports</div>
                <div className="mfp-stat-big">{stats?.total_airports ?? '—'}</div>
                <div className="mfp-stat-unit">→ Details</div>
            </div>
        </div>
    );

    // ── 共用：list content ────────────────────────────────────────────────────
    const listContent = (
        <>
            {view === 'stats' ? (
                <StatsDashboard stats={stats} onBack={goBack} />
            ) : (
                <div className="mfp-list">
                    {loading && <div className="mfp-loading">Loading…</div>}
                    {!loading && flights.length === 0 && (
                        <div className="mfp-empty">
                            <Plane size={32} style={{ opacity: 0.3 }} />
                            <p>No flights logged yet</p>
                            <button className="mfp-log-btn" onClick={() => { setEditTarget(null); setView('form'); }}>
                                Log your first flight
                            </button>
                        </div>
                    )}
                    {flights.map(f => (
                        <FlightRow
                            key={f.id}
                            flight={f}
                            onEdit={fl => { setEditTarget(fl); setView('form'); }}
                            onDelete={setDeleteTarget}
                        />
                    ))}
                    {totalPages > 1 && (
                        <div className="mfp-pagination">
                            <button className="mfp-page-btn" disabled={page <= 1} onClick={() => loadFlights(page - 1)}>
                                <ChevronLeft size={14} />
                            </button>
                            <span className="mfp-page-info">{page} / {totalPages}</span>
                            <button className="mfp-page-btn" disabled={page >= totalPages} onClick={() => loadFlights(page + 1)}>
                                <ChevronRight size={14} />
                            </button>
                        </div>
                    )}
                </div>
            )}
            {toast && <div className="mfp-toast"><CheckCircle size={11} /> {toast}</div>}
        </>
    );

    // ── 全頁模式 ───────────────────────────────────────────────────────────────
    if (mode === 'page') {
        return (
            <>
            <div className="mfp-page">
                <div className="mfp-page-topbar">
                    <button className="mfp-page-back" onClick={onClose}>
                        <ChevronLeft size={16} /> 返回地圖
                    </button>
                    <div className="mfp-page-title">
                        <Plane size={14} />
                        <span>Flight log</span>
                        <span className="mfp-page-count">{total} sectors</span>
                    </div>
                    <div className="mfp-page-actions">
                        {view === 'list' && (
                            <button className="mfp-log-btn" onClick={() => { setEditTarget(null); setView('form'); }}>
                                <Plus size={12} /> Log flight
                            </button>
                        )}
                        {view !== 'list' && (
                            <button className="mfp-ghost-btn" onClick={goBack}>← 記錄列表</button>
                        )}
                    </div>
                </div>
                <div className="mfp-page-body">
                    <div className="mfp-page-inner">
                        {statsStrip}
                        {listContent}
                    </div>
                </div>
            </div>
            {deleteTarget && (
                <ConfirmDialog
                    title="刪除航班記錄"
                    message="確定刪除這筆航班記錄？此操作無法復原。"
                    confirmLabel="刪除"
                    onConfirm={confirmDelete}
                    onCancel={() => setDeleteTarget(null)}
                />
            )}
            </>
        );
    }

    // ── Modal 模式 ────────────────────────────────────────────────────────────
    return (
        <div className="mfp-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="mfp-panel">
                <div className="mfp-panel-header">
                    <div className="mfp-panel-title">
                        <div className="mfp-panel-eyebrow">Aerostrat · Personal record</div>
                        <div className="mfp-panel-name">
                            <Plane size={16} /> Flight log
                            <span className="mfp-panel-count">{total} sectors</span>
                        </div>
                    </div>
                    <div className="mfp-panel-acts">
                        {view === 'list' && (
                            <button className="mfp-log-btn" onClick={() => { setEditTarget(null); setView('form'); }}>
                                <Plus size={11} /> Log flight
                            </button>
                        )}
                        <button className="mfp-close-btn" onClick={onClose}><X size={14} /></button>
                    </div>
                </div>
                {statsStrip}
                <div className="mfp-panel-content">{listContent}</div>
            </div>
            {deleteTarget && (
                <ConfirmDialog
                    title="刪除航班記錄"
                    message="確定刪除這筆航班記錄？此操作無法復原。"
                    confirmLabel="刪除"
                    onConfirm={confirmDelete}
                    onCancel={() => setDeleteTarget(null)}
                />
            )}
        </div>
    );
}
