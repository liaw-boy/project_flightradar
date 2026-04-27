/**
 * DevPanel — 開發者監控浮動面板
 *
 * 使用方式：按 Ctrl+D 開啟/關閉
 * 位置可拖曳，並持久化至 localStorage
 *
 * 顯示資訊：
 *   - Canvas 渲染：FPS、渲染架數、視野架數
 *   - 網路：WebSocket 狀態、API latency
 *   - OpenSky 帳號額度
 *   - 記憶體（如瀏覽器支援）
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { authStore } from '../store/authStore';
import './DevPanel.css';

function authHeader() {
    const token = authStore.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── FPS bar helper ──────────────────────────────────────────────
function FpsBar({ fps }) {
    const pct = Math.min(100, Math.round((fps / 60) * 100));
    const color = fps >= 50 ? '#10b981' : fps >= 30 ? '#f59e0b' : '#ef4444';
    return (
        <div className="dp-fps-row">
            <span className="dp-fps-num" style={{ color }}>{fps}</span>
            <span className="dp-fps-label">/ 60 fps</span>
            <div className="dp-fps-bar">
                <div className="dp-fps-fill" style={{ width: `${pct}%`, background: color }} />
            </div>
        </div>
    );
}

// ── Account quota row ───────────────────────────────────────────
function AccountRow({ account }) {
    const pct = account.remainingCredits > 0
        ? Math.round((account.remainingCredits / 4000) * 100)
        : 0;
    const locked = account.unlockTime && new Date(account.unlockTime) > new Date();
    const color = locked ? '#ef4444' : pct > 50 ? '#10b981' : pct > 20 ? '#f59e0b' : '#ef4444';
    const shortName = account.user?.replace(/-api-client/g, '') ?? '—';

    return (
        <div className="dp-account-row">
            <span className="dp-acct-dot" style={{ background: locked ? '#ef4444' : '#10b981' }} />
            <span className="dp-acct-name">{shortName}</span>
            <span className="dp-acct-credits" style={{ color }}>
                {locked ? 'LOCKED' : `${account.remainingCredits?.toLocaleString() ?? '?'}`}
            </span>
            <div className="dp-acct-bar">
                <div className="dp-acct-fill" style={{ width: `${pct}%`, background: color }} />
            </div>
        </div>
    );
}

// ── Section wrapper ─────────────────────────────────────────────
function Section({ title, icon, children }) {
    const [open, setOpen] = useState(true);
    return (
        <div className="dp-section">
            <div className="dp-section-hd" onClick={() => setOpen(o => !o)}>
                <span>{icon} {title}</span>
                <span className="dp-chevron">{open ? '▴' : '▾'}</span>
            </div>
            {open && <div className="dp-section-body">{children}</div>}
        </div>
    );
}

// ── Main DevPanel ───────────────────────────────────────────────
export default function DevPanel({ usageStats, apiStatus, apiStats, latency, planeCount }) {
    // ── Draggable position ──────────────────────────────────────
    const STORAGE_KEY = 'devpanel_pos';
    const defaultPos = { x: 16, y: window.innerHeight - 380 };
    const [pos, setPos] = useState(() => {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? defaultPos; }
        catch { return defaultPos; }
    });
    const dragging = useRef(false);
    const dragOffset = useRef({ x: 0, y: 0 });
    const panelRef = useRef(null);

    const onMouseDown = useCallback((e) => {
        if (!e.target.closest('.dp-handle')) return;
        dragging.current = true;
        dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
        e.preventDefault();
    }, [pos]);

    useEffect(() => {
        const onMove = (e) => {
            if (!dragging.current) return;
            const newPos = {
                x: Math.max(0, Math.min(window.innerWidth  - 240, e.clientX - dragOffset.current.x)),
                y: Math.max(0, Math.min(window.innerHeight - 100, e.clientY - dragOffset.current.y)),
            };
            setPos(newPos);
        };
        const onUp = () => {
            if (dragging.current) {
                dragging.current = false;
                setPos(p => { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); return p; });
            }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    }, []);

    // ── Backend health poll (every 5s) ──────────────────────────
    const [health, setHealth] = useState(null);
    useEffect(() => {
        const fetch_ = () =>
            fetch('/api/health', { headers: authHeader() }).then(r => r.ok ? r.json() : null).then(d => d && setHealth(d)).catch(() => {});
        fetch_();
        const id = setInterval(fetch_, 5000);
        return () => clearInterval(id);
    }, []);

    // ── Memory (if available) ───────────────────────────────────
    const mem = performance.memory
        ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024)
        : null;

    const fps = usageStats?.fps ?? 0;
    const rendered = usageStats?.visibleCount ?? 0;
    const inView   = usageStats?.totalInView  ?? 0;
    const throttle = usageStats?.throttleFactor ?? 1.0;
    const isThrottled = throttle < 1.0;

    const wsOk = apiStatus === 'online' || apiStatus === 'ws-active';
    const accounts = apiStats?.accounts ?? [];

    const syncCycle = health?.ingestion?.totalBatches ?? '—';
    const lastBatch = health?.ingestion?.lastBatchSize ?? '—';
    const lastBatchMs = health?.ingestion?.lastBatchMs ?? '—';
    const uptime = health ? Math.round(health.uptime / 60) : null;

    return (
        <div
            ref={panelRef}
            className="dev-panel"
            style={{ left: pos.x, top: pos.y }}
            onMouseDown={onMouseDown}
        >
            {/* ── Header ── */}
            <div className="dp-header dp-handle">
                <span className="dp-title">🛠 DEV MONITOR</span>
                <span className="dp-hint">Ctrl+D</span>
            </div>

            {/* ── RENDER ── */}
            <Section title="RENDER" icon="◉">
                <FpsBar fps={fps} />
                <div className="dp-row">
                    <span className="dp-lbl">Rendered</span>
                    <span className="dp-val">{rendered} <span className="dp-dim">/ {inView} in view</span></span>
                </div>
                {isThrottled && (
                    <div className="dp-row dp-warn">
                        <span className="dp-lbl">Throttle</span>
                        <span className="dp-val" style={{ color: '#f59e0b' }}>{(throttle * 100).toFixed(0)}%</span>
                    </div>
                )}
                {mem && (
                    <div className="dp-row">
                        <span className="dp-lbl">JS Heap</span>
                        <span className="dp-val">{mem} MB</span>
                    </div>
                )}
            </Section>

            {/* ── NETWORK ── */}
            <Section title="NETWORK" icon="◈">
                <div className="dp-row">
                    <span className="dp-lbl">WebSocket</span>
                    <span className="dp-val">
                        <span className="dp-dot" style={{ background: wsOk ? '#10b981' : '#ef4444' }} />
                        {wsOk ? 'Connected' : apiStatus ?? 'Unknown'}
                    </span>
                </div>
                <div className="dp-row">
                    <span className="dp-lbl">API Latency</span>
                    <span className="dp-val"
                        style={{ color: latency > 500 ? '#f59e0b' : '#10b981' }}>
                        {latency ? `${latency} ms` : '—'}
                    </span>
                </div>
                <div className="dp-row">
                    <span className="dp-lbl">Planes</span>
                    <span className="dp-val">{planeCount?.toLocaleString() ?? '—'}</span>
                </div>
            </Section>

            {/* ── SYNC ── */}
            <Section title="SYNC" icon="⟳">
                <div className="dp-row">
                    <span className="dp-lbl">Cycle #</span>
                    <span className="dp-val">{syncCycle}</span>
                </div>
                <div className="dp-row">
                    <span className="dp-lbl">Last batch</span>
                    <span className="dp-val">{lastBatch} planes <span className="dp-dim">{lastBatchMs}ms</span></span>
                </div>
                {uptime !== null && (
                    <div className="dp-row">
                        <span className="dp-lbl">Uptime</span>
                        <span className="dp-val">{uptime} min</span>
                    </div>
                )}
            </Section>

            {/* ── OPENSKY ACCOUNTS ── */}
            {accounts.length > 0 && (
                <Section title="OPENSKY" icon="🔑">
                    {accounts.map(a => <AccountRow key={a.user} account={a} />)}
                </Section>
            )}
        </div>
    );
}
