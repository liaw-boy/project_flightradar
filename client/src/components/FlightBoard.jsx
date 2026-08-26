import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { X, PlaneLanding, PlaneTakeoff, RefreshCw } from 'lucide-react';
import './FlightBoard.css';

const STATUS_CLASS = (remark) => {
    if (!remark) return '';
    if (/ARRIVED|DEPARTED|已到|出發/.test(remark)) return 'fb-status-done';
    if (/CANCEL|取消/.test(remark)) return 'fb-status-cancel';
    if (/DELAY|延誤/.test(remark)) return 'fb-status-delay';
    return 'fb-status-normal';
};

function fmtTime(iso) {
    if (!iso) return '--:--';
    // TDX returns local Taipei wall-clock time with no offset (e.g. "2026-08-25T00:10")
    const m = iso.match(/T(\d{2}:\d{2})/);
    return m ? m[1] : '--:--';
}

export default function FlightBoard({ onClose }) {
    const [tab, setTab] = useState('arrivals');
    const [board, setBoard] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        try {
            setError(null);
            const res = await fetch('/api/fids/board?iata=TPE');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setBoard(data);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
        const interval = setInterval(load, 5 * 60 * 1000); // matches backend refresh cadence
        return () => clearInterval(interval);
    }, [load]);

    // Show the window around "now" — a few hours back (recently landed/departed)
    // through the rest of the day ahead, sorted by scheduled time.
    const rows = useMemo(() => {
        if (!board) return [];
        const list = tab === 'arrivals' ? board.arrivals : board.departures;
        const nowMs = Date.now();
        const windowStart = nowMs - 3 * 3600 * 1000;
        const windowEnd = nowMs + 20 * 3600 * 1000;
        return list
            .filter(f => f.scheduleTime && !f.isCargo)
            .map(f => ({ ...f, _t: new Date(f.scheduleTime + '+08:00').getTime() }))
            .filter(f => f._t >= windowStart && f._t <= windowEnd)
            .sort((a, b) => a._t - b._t);
    }, [board, tab]);

    return (
        <div className="fb-overlay">
            <div className="fb-panel">
                <div className="fb-header">
                    <div className="fb-title">
                        <span>桃園國際機場 起降看板</span>
                        {board?.updatedAt && (
                            <span className="fb-updated">更新於 {new Date(board.updatedAt).toLocaleTimeString('zh-TW', { hour12: false })}</span>
                        )}
                    </div>
                    <div className="fb-header-actions">
                        <button className="fb-icon-btn" onClick={load} title="重新整理">
                            <RefreshCw size={16} />
                        </button>
                        <button className="fb-icon-btn" onClick={onClose} title="關閉">
                            <X size={18} />
                        </button>
                    </div>
                </div>

                <div className="fb-tabs">
                    <button className={`fb-tab ${tab === 'arrivals' ? 'active' : ''}`} onClick={() => setTab('arrivals')}>
                        <PlaneLanding size={14} /> 抵達
                    </button>
                    <button className={`fb-tab ${tab === 'departures' ? 'active' : ''}`} onClick={() => setTab('departures')}>
                        <PlaneTakeoff size={14} /> 出發
                    </button>
                </div>

                <div className="fb-table-wrap">
                    {loading && <div className="fb-empty">載入中…</div>}
                    {!loading && error && <div className="fb-empty fb-error">載入失敗：{error}</div>}
                    {!loading && !error && rows.length === 0 && <div className="fb-empty">目前時段沒有航班資料</div>}
                    {!loading && !error && rows.length > 0 && (
                        <table className="fb-table">
                            <thead>
                                <tr>
                                    <th>班機</th>
                                    <th>{tab === 'arrivals' ? '起飛地' : '目的地'}</th>
                                    <th>表定</th>
                                    <th>{tab === 'arrivals' ? '實際/預計' : '實際/預計'}</th>
                                    <th>航廈</th>
                                    <th>{tab === 'arrivals' ? '登機門/行李' : '登機門/櫃檯'}</th>
                                    <th>狀態</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((f, i) => (
                                    <tr key={`${f.flightNo}-${f.scheduleTime}-${i}`}>
                                        <td className="fb-flightno">{f.flightNo || '—'}</td>
                                        <td>{tab === 'arrivals' ? (f.from || '—') : (f.to || '—')}</td>
                                        <td>{fmtTime(f.scheduleTime)}</td>
                                        <td>{fmtTime(f.actualTime || f.estimatedTime)}</td>
                                        <td>{f.terminal || '—'}</td>
                                        <td>{tab === 'arrivals' ? (f.gate || f.baggageClaim || '—') : (f.gate || f.checkInCounter || '—')}</td>
                                        <td><span className={`fb-status ${STATUS_CLASS(f.remark)}`}>{f.remark || '—'}</span></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    );
}
