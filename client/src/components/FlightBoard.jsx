import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X, ChevronDown, MapPin, Clock, DoorOpen, Plane as PlaneIcon, Search } from 'lucide-react';
import './FlightBoard.css';

const STATUS_META = {
    done:      { cls: 'st-good',     zh: '已完成' },
    ontime:    { cls: 'st-good',     zh: '準時' },
    boarding:  { cls: 'st-boarding', zh: '登機中' },
    delayed:   { cls: 'st-warn',     zh: '延誤' },
    cancelled: { cls: 'st-bad',      zh: '取消' },
};
const statusMeta = (status) => STATUS_META[status] || { cls: 'st-neutral', zh: status || '—' };

function fmtTime(iso) {
    if (!iso) return null;
    const t = iso.split('T')[1];
    return t ? t.slice(0, 5) : iso;
}

function airlineLogoUrl(code) {
    return `https://pics.avs.io/60/60/${code}.png`;
}

function Dash({ value }) {
    return value ? <>{value}</> : <span className="empty-dash">—</span>;
}

function TimeCell({ f }) {
    const sched = fmtTime(f.scheduledTime) || '—';
    const actualOrEst = f.actualTime ? fmtTime(f.actualTime) : (f.estimatedTime ? fmtTime(f.estimatedTime) : null);

    if (f.status === 'cancelled') {
        return (
            <div className="time-stack">
                <span className="cell-time">{sched}</span>
                <hr className="time-divider" />
                <span className="cell-time time-sched">-</span>
            </div>
        );
    }
    if (f.status === 'delayed' && actualOrEst) {
        return (
            <div className="time-stack">
                <span className="cell-time time-strike">{sched}</span>
                <hr className="time-divider" />
                <span className="cell-time time-sched shift">{actualOrEst}</span>
            </div>
        );
    }
    const second = actualOrEst || sched;
    return (
        <div className="time-stack">
            <span className="cell-time time-actual">{sched}</span>
            <hr className="time-divider" />
            <span className="cell-time time-sched">{second}</span>
        </div>
    );
}

function AirlineLogo({ code, className }) {
    const [failed, setFailed] = useState(false);
    if (failed || !code) return <span className={`${className} fallback`}>{code || '—'}</span>;
    return <img className={className} src={airlineLogoUrl(code)} alt={code} loading="lazy" onError={() => setFailed(true)} />;
}

export default function FlightBoard({ onClose }) {
    const [airports, setAirports] = useState([]);
    const [airport, setAirport] = useState('TPE');
    const [direction, setDirection] = useState('arrival');
    const [terminal, setTerminal] = useState('all');
    const [airline, setAirline] = useState('');
    const [cargo, setCargo] = useState(false);
    const [history, setHistory] = useState(false);
    const [query, setQuery] = useState('');
    const [flights, setFlights] = useState([]);
    const [stats, setStats] = useState(null);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [detail, setDetail] = useState(null);
    const searchDebounce = useRef(null);

    useEffect(() => {
        fetch('/api/airports').then(r => r.json()).then(d => setAirports(d.airports || [])).catch(() => {});
    }, []);

    const load = useCallback(async () => {
        try {
            setError(null);
            const params = new URLSearchParams({
                airport, direction,
                ...(terminal !== 'all' ? { terminal } : {}),
                ...(airline ? { airline } : {}),
                ...(cargo ? { cargo: '1' } : {}),
                ...(history ? { all: '1' } : {}),
            });
            const [flightsRes, statsRes] = await Promise.all([
                fetch(`/api/flights?${params}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
                fetch(`/api/flights/stats?${new URLSearchParams({ airport, direction, ...(cargo ? { cargo: '1' } : {}) })}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
            ]);
            setFlights(flightsRes.flights || []);
            setLastUpdated(flightsRes.lastUpdated);
            setStats(statsRes);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [airport, direction, terminal, airline, cargo, history]);

    useEffect(() => {
        load();
        const interval = setInterval(load, 5 * 60 * 1000);
        return () => clearInterval(interval);
    }, [load]);

    const isArr = direction === 'arrival';

    const airlineOptions = useMemo(() => {
        const known = {};
        flights.forEach(f => { known[f.airlineId] = f.airlineName; });
        return Object.keys(known).sort().map(code => ({ code, name: known[code] }));
    }, [flights]);

    const filtered = useMemo(() => {
        if (!query) return flights;
        const needle = query.toLowerCase();
        return flights.filter(f => {
            const place = isArr ? f.origin : f.destination;
            const placeCity = isArr ? f.originCity : f.destinationCity;
            const codeshareNos = (f.codeshares || []).map(c => c.flightNumber);
            const haystack = [f.flightNumber, f.airlineName, place, placeCity].concat(codeshareNos).filter(Boolean).join(' ').toLowerCase();
            return haystack.includes(needle);
        });
    }, [flights, query, isArr]);

    const staleness = useMemo(() => {
        if (!lastUpdated) return { text: '尚未取得資料', stale: true };
        const ts = new Date(lastUpdated).getTime();
        if (isNaN(ts)) return { text: '尚未取得資料', stale: true };
        const stale = Date.now() - ts > 6 * 60 * 1000;
        const local = new Date(ts).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit' });
        return { text: `最後更新 ${local}`, stale };
    }, [lastUpdated]);

    const onSearchChange = (e) => {
        const value = e.target.value;
        clearTimeout(searchDebounce.current);
        searchDebounce.current = setTimeout(() => setQuery(value.trim()), 120);
    };

    const placeLabel = (f) => {
        const place = isArr ? f.origin : f.destination;
        const city = isArr ? f.originCity : f.destinationCity;
        return city ? `${city} ${place}` : place;
    };

    return (
        <div className="fb-overlay">
            <header className="fb-topnav">
                <span className="fb-brand">Airport Live Status</span>
                <div className="fb-airport-selector">
                    <MapPin size={16} />
                    <select value={airport} onChange={e => setAirport(e.target.value)} aria-label="機場">
                        {airports.map(a => <option key={a.code} value={a.code}>{a.code}</option>)}
                    </select>
                    <ChevronDown size={14} />
                </div>
                <button className="fb-close" onClick={onClose} aria-label="關閉"><X size={20} /></button>
            </header>

            <div className="fb-shell">
                <div className="fb-masthead">
                    <div className="fb-masthead-id">
                        <h1>
                            {airports.find(a => a.code === airport)?.name || airport}
                            <span>即時航班看板・{airport} Airport Live Status</span>
                        </h1>
                        <div className="fb-masthead-meta">
                            <span className={`fb-live-dot ${staleness.stale ? 'stale' : ''}`} />
                            <span>{staleness.stale ? '延遲中' : '即時'}</span>
                            <span className="fb-updated-tag">{staleness.text}</span>
                        </div>
                        {stats && (
                            <div className="fb-masthead-stats">
                                <div className="fb-mstat"><b>{stats.total}</b><span>今日航班</span></div>
                                <div className="fb-mstat"><b className={stats.onTimeRate < 85 ? 'warn' : ''}>{stats.onTimeRate}%</b><span>準點率</span></div>
                                <div className="fb-mstat"><b className={stats.delayed > 0 ? 'warn' : ''}>{stats.delayed}</b><span>延誤中</span></div>
                                <div className="fb-mstat"><b>{stats.done}</b><span>{isArr ? '已抵達' : '已出發'}</span></div>
                            </div>
                        )}
                    </div>

                    <div className="fb-masthead-controls">
                        <div className="fb-seg" role="tablist" aria-label="航廈">
                            {['all', '1', '2'].map(t => (
                                <button key={t} className={terminal === t ? 'active' : ''} onClick={() => setTerminal(t)}>
                                    {t === 'all' ? '全部航廈' : `T${t}`}
                                </button>
                            ))}
                        </div>
                        <div className="fb-seg" role="tablist" aria-label="方向">
                            <button className={isArr ? 'active' : ''} onClick={() => setDirection('arrival')}>抵達</button>
                            <button className={!isArr ? 'active' : ''} onClick={() => setDirection('departure')}>出發</button>
                        </div>
                        <select className="fb-field-select" value={airline} onChange={e => setAirline(e.target.value)} aria-label="航空公司">
                            <option value="">所有航空公司</option>
                            {airlineOptions.map(a => <option key={a.code} value={a.code}>{a.code} ・ {a.name}</option>)}
                        </select>
                        <label className="fb-cargo-toggle">
                            <input type="checkbox" checked={cargo} onChange={e => setCargo(e.target.checked)} />
                            <span>顯示貨機</span>
                        </label>
                        <div className="fb-field-search">
                            <Search size={16} />
                            <input type="text" placeholder="班機號、城市、目的地…" defaultValue={query} onChange={onSearchChange} autoComplete="off" />
                        </div>
                        <button className={`fb-history-btn ${history ? 'active' : ''}`} onClick={() => setHistory(v => !v)}>
                            {history ? '回到即時' : '查看更早航班'}
                        </button>
                    </div>
                </div>

                {loading && <p className="fb-state-msg">載入航班資料中…</p>}
                {!loading && error && <p className="fb-state-msg fb-error">航班資料載入失敗，請稍後重新整理（{error}）</p>}
                {!loading && !error && filtered.length === 0 && <p className="fb-state-msg">沒有符合篩選條件的航班</p>}

                {!loading && !error && filtered.length > 0 && (
                    <>
                        <div className="fb-board fb-board-desktop">
                            <div className="fb-board-scroll">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>航空公司</th>
                                            <th>班機號</th>
                                            <th>{isArr ? '出發地' : '目的地'}</th>
                                            <th>表定 / 預計</th>
                                            <th>登機門</th>
                                            <th>航廈</th>
                                            <th>機型</th>
                                            <th className="num">{isArr ? '行李轉盤' : '報到櫃檯'}</th>
                                            <th className="num">狀態</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filtered.map((f, i) => {
                                            const meta = statusMeta(f.status);
                                            const sub = isArr ? f.baggageClaim : f.checkCounter;
                                            return (
                                                <tr key={`${f.flightNumber}-${f.scheduledTime}-${i}`}
                                                    className={`fb-flight-row ${f.status === 'cancelled' ? 'st-cancelled' : ''}`}
                                                    onClick={() => setDetail(f)}>
                                                    <td><div className="fb-flight-cell"><AirlineLogo code={f.airlineId} className="fb-airline-logo" /><span className="fb-airline-name">{f.airlineName}</span></div></td>
                                                    <td>
                                                        <span className={`fb-flight-no ${f.status === 'cancelled' ? 'time-strike' : ''}`}>
                                                            {f.flightNumber}
                                                            {f.codeshares?.length > 0 && <span className="fb-codeshare-tag">/ {f.codeshares.map(c => c.flightNumber).join(' / ')}</span>}
                                                        </span>
                                                    </td>
                                                    <td className="fb-place-cell"><span className="fb-icon-cell"><MapPin size={16} /><span className="fb-place-main"><Dash value={placeLabel(f)} /></span></span></td>
                                                    <td><span className="fb-icon-cell"><Clock size={16} /><TimeCell f={f} /></span></td>
                                                    <td>{f.gate
                                                        ? <span className={`fb-icon-cell ${f.status === 'boarding' ? 'gate-active' : ''}`}><DoorOpen size={16} /><span className="fb-gate-badge">{f.gate}</span></span>
                                                        : <span className="empty-dash">—</span>}
                                                    </td>
                                                    <td><span className="fb-tmb"><Dash value={f.terminal ? `T${f.terminal}` : null} /></span></td>
                                                    <td><span className="fb-icon-cell"><PlaneIcon size={16} /><span><Dash value={f.acType} /></span></span></td>
                                                    <td className="num"><Dash value={sub} /></td>
                                                    <td className="num"><span className={`fb-chip ${meta.cls}`}>{meta.zh}</span></td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <div className="fb-cards">
                            {filtered.map((f, i) => {
                                const meta = statusMeta(f.status);
                                const place = isArr ? f.origin : f.destination;
                                const placeCity = isArr ? f.originCity : f.destinationCity;
                                const sub = isArr ? f.baggageClaim : f.checkCounter;
                                const subLabel = isArr ? '行李轉盤' : '報到櫃檯';
                                return (
                                    <div key={`${f.flightNumber}-${f.scheduledTime}-${i}`}
                                        className={`fb-fcard ${f.status === 'cancelled' ? 'st-cancelled' : ''}`}
                                        onClick={() => setDetail(f)}>
                                        <div className="fb-fcard-top">
                                            <AirlineLogo code={f.airlineId} className="fb-airline-logo" />
                                            <div className="fb-fcard-top-text">
                                                <div className={`fb-fcard-flightno ${f.status === 'cancelled' ? 'time-strike' : ''}`}>
                                                    {f.flightNumber}
                                                    {f.codeshares?.length > 0 && <span className="fb-codeshare-tag">/ {f.codeshares.map(c => c.flightNumber).join(' / ')}</span>}
                                                </div>
                                                <div className="fb-fcard-airline">{f.airlineName}</div>
                                            </div>
                                            <span className={`fb-chip ${meta.cls}`}>{meta.zh}</span>
                                        </div>
                                        <div className="fb-fcard-route">
                                            <MapPin size={16} />
                                            <div className="fb-fcard-place">
                                                <div className="fb-fcard-place-main"><Dash value={placeCity || place} /></div>
                                                <div className="fb-fcard-place-code"><Dash value={place} /></div>
                                            </div>
                                            <div className="fb-fcard-time"><TimeCell f={f} /></div>
                                        </div>
                                        <div className="fb-fcard-footer">
                                            <div><span>航廈/登機門</span><b><Dash value={f.terminal ? `T${f.terminal}` : null} />{f.gate ? ` · ${f.gate}` : ''}</b></div>
                                            <div><span>機型</span><b><Dash value={f.acType} /></b></div>
                                            <div><span>{subLabel}</span><b><Dash value={sub} /></b></div>
                                            <div><span>狀態</span><b>{meta.zh}</b></div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}

                <footer className="fb-note">資料來源：交通部 TDX 運輸資料流通服務（FIDS）・每 5 分鐘自動更新</footer>
            </div>

            {detail && <DetailPanel f={detail} isArr={isArr} onClose={() => setDetail(null)} />}
        </div>
    );
}

function DetailPanel({ f, isArr, onClose }) {
    const meta = statusMeta(f.status);
    const estVal = f.estimatedTime ? fmtTime(f.estimatedTime) : null;
    const showEst = estVal && estVal !== fmtTime(f.scheduledTime);
    const actVal = f.actualTime ? fmtTime(f.actualTime) : null;
    const sub = isArr ? f.baggageClaim : f.checkCounter;
    const subLabel = isArr ? '行李轉盤' : '報到櫃檯';
    const upd = f.updateTime ? fmtTime(f.updateTime) : null;

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div className="fb-detail-backdrop open" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="fb-detail-panel" role="dialog" aria-modal="true">
                <button className="fb-detail-close" onClick={onClose} aria-label="關閉"><X size={20} /></button>

                <header className="fb-detail-header">
                    <AirlineLogo code={f.airlineId} className="fb-detail-logo" />
                    <div>
                        <h2>{f.flightNumber}</h2>
                        <p>{f.airlineName}</p>
                    </div>
                    <span className={`fb-chip ${meta.cls}`}>{meta.zh}</span>
                </header>

                <section className="fb-detail-route">
                    <div className="fb-detail-route-end">
                        <div className="fb-detail-route-code">{f.origin || '—'}</div>
                        <div className="fb-detail-route-city">{f.originCity || ''}</div>
                        <div className="fb-detail-route-label">出發地 ORIGIN</div>
                    </div>
                    <div className="fb-detail-route-mid"><PlaneIcon size={18} /></div>
                    <div className="fb-detail-route-end fb-detail-route-end-right">
                        <div className="fb-detail-route-code">{f.destination || '—'}</div>
                        <div className="fb-detail-route-city">{f.destinationCity || ''}</div>
                        <div className="fb-detail-route-label">目的地 DESTINATION</div>
                    </div>
                </section>

                <section className="fb-detail-timeline">
                    <h3>時刻</h3>
                    <div className="fb-tl-row">
                        <div className="fb-tl-dot" />
                        <div className="fb-tl-body"><span>表定時間</span><b>{fmtTime(f.scheduledTime) || '—'}</b></div>
                    </div>
                    {showEst && (
                        <div className="fb-tl-row">
                            <div className="fb-tl-dot" />
                            <div className="fb-tl-body"><span>預計時間</span><b>{estVal}</b></div>
                        </div>
                    )}
                    {actVal && (
                        <div className="fb-tl-row">
                            <div className="fb-tl-dot fb-tl-dot-fill" />
                            <div className="fb-tl-body"><span>實際時間</span><b>{actVal}</b></div>
                        </div>
                    )}
                    {f.remark && <p className="fb-detail-remark">{f.remark}</p>}
                </section>

                <section className="fb-detail-grid">
                    <div><span>航廈</span><b>{f.terminal ? `T${f.terminal}` : '—'}</b></div>
                    <div><span>登機門</span><b>{f.gate || '—'}</b></div>
                    <div><span>機型</span><b>{f.acType || '—'}</b></div>
                    <div><span>{subLabel}</span><b>{sub || '—'}</b></div>
                </section>

                {upd && <p className="fb-detail-updated">資料更新於 {upd}</p>}
            </div>
        </div>
    );
}
