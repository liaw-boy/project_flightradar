'use strict';
// Standalone HTML/CSS/client-JS generator for the /monitor system dashboard.
// AEROSTRAT_VERSION is passed in rather than imported to keep this module
// free of any dependency on server.js's module-level state.
function getMonitorHtml(AEROSTRAT_VERSION) {
    return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<title>AEROSTRAT MONITOR</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#020617;
  --panel:#0f172a;
  --panel2:#1e293b;
  --border:rgba(148,163,184,0.15);
  --teal:#22d3ee;
  --amber:#f59e0b;
  --red:#ef4444;
  --green:#10b981;
  --t:#f8fafc;
  --tm:#94a3b8;
  --td:#64748b;
  --font:'Inter',sans-serif;
}
html,body{height:100%;background:var(--bg);color:var(--t);font-family:var(--font);font-size:14px;overflow:hidden}
a{color:var(--teal);text-decoration:none}
a:hover{opacity:.75}

/* ── Layout ── */
.layout{display:flex;height:100vh;overflow:hidden}

/* ── Sidebar ── */
.sidebar{width:220px;min-width:220px;background:var(--bg);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:0;overflow-y:auto;flex-shrink:0}
.sb-brand{padding:24px 20px 20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border)}
.sb-brand-icon{width:18px;height:18px;flex-shrink:0}
.sb-brand-text{font-size:13px;font-weight:700;letter-spacing:.08em;color:var(--t)}
.sb-brand-ver{font-size:10px;color:var(--td);margin-top:2px}
.sb-nav{padding:16px 12px;flex:1;display:flex;flex-direction:column;gap:2px}
.sb-nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;font-size:12px;font-weight:500;color:var(--td);cursor:pointer;transition:all .18s;text-decoration:none;border:none;background:none;width:100%;text-align:left}
.sb-nav-item:hover{color:var(--t);background:rgba(255,255,255,0.05)}
.sb-nav-item.active{background:var(--teal);color:#020617;font-weight:600}
.sb-nav-item.active .sb-nav-icon{color:#020617}
.sb-nav-icon{width:14px;height:14px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.sb-nav-icon svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.sb-divider{height:1px;background:var(--border);margin:8px 12px}
.sb-section-lbl{padding:8px 12px 4px;font-size:10px;font-weight:600;color:var(--td);letter-spacing:.1em;text-transform:uppercase}
.sb-footer{padding:16px 20px;border-top:1px solid var(--border);font-size:11px;color:var(--td)}

/* ── Main ── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg)}
.topbar-left{display:flex;flex-direction:column}
.topbar-title{font-size:15px;font-weight:700;color:var(--t)}
.topbar-sub{font-size:11px;color:var(--td);margin-top:2px}
.topbar-right{display:flex;align-items:center;gap:16px}
.sync-badge{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--td);background:var(--panel);padding:6px 12px;border-radius:20px;border:1px solid var(--border)}
.sync-dot{width:7px;height:7px;border-radius:50%;background:var(--amber);flex-shrink:0;transition:background .3s}
.sync-dot.ok{background:var(--green);box-shadow:0 0 6px var(--green)}
.sync-dot.err{background:var(--red)}
.btn-back{font-size:12px;font-weight:500;color:var(--teal);background:rgba(169,223,216,.1);padding:6px 14px;border-radius:20px;border:1px solid rgba(169,223,216,.2);cursor:pointer;transition:all .18s}
.btn-back:hover{background:rgba(169,223,216,.18)}

/* ── Scroll area ── */
.scroll{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:18px}
.scroll::-webkit-scrollbar{width:6px}
.scroll::-webkit-scrollbar-track{background:transparent}
.scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:3px}

/* ── Section label ── */
.section-hd{font-size:13px;font-weight:600;color:var(--tm);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.section-hd::after{content:'';flex:1;height:1px;background:var(--border)}

/* ── KPI Cards ── */
.kpi-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.kpi-card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px 16px;position:relative;overflow:hidden;transition:transform .2s}
.kpi-card:hover{transform:translateY(-2px)}
.kpi-card::after{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0}
.kpi-card.c-teal::after{background:var(--teal)}
.kpi-card.c-amber::after{background:var(--amber)}
.kpi-card.c-green::after{background:var(--green)}
.kpi-card.c-red::after{background:var(--red)}
.kpi-card.c-purple::after{background:#a855f7}
.kpi-val{font-size:26px;font-weight:700;line-height:1;margin-bottom:6px;color:var(--t)}
.kpi-lbl{font-size:10px;font-weight:600;color:var(--td);letter-spacing:.12em;text-transform:uppercase;margin-bottom:4px}
.kpi-trend{font-size:10px;color:var(--tm)}
.skel{background:linear-gradient(90deg,var(--panel) 25%,var(--panel2) 50%,var(--panel) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:4px;height:26px;width:70%;opacity:.6}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* ── Cards ── */
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.card-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border)}
.card-title{font-size:13px;font-weight:600;color:var(--t)}
.card-badge{font-size:11px;font-weight:600;color:var(--teal);background:rgba(169,223,216,.1);padding:3px 10px;border-radius:20px;border:1px solid rgba(169,223,216,.2)}
.card-body{padding:18px;flex:1}

/* ── Progress bars ── */
.bar-row{margin-bottom:14px}
.bar-row:last-child{margin-bottom:0}
.bar-hd{display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;color:var(--tm)}
.bar-hd .bar-lbl{font-weight:500;color:var(--td)}
.bar-bg{height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden}
.bar-fill{height:100%;border-radius:3px;width:0%;transition:width 1s cubic-bezier(.4,0,.2,1)}

/* ── Donut charts ── */
.donut-row{display:flex;gap:20px;margin-bottom:16px;align-items:center}
.donut-wrap{position:relative;display:flex;align-items:center;justify-content:center}
.donut-wrap svg{display:block}
.donut-center{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;top:0;left:0;right:0;bottom:0}
.donut-pct{font-size:15px;font-weight:700;color:var(--t)}
.donut-sub{font-size:9px;color:var(--td);margin-top:1px}
.donut-info{flex:1}
.donut-title{font-size:13px;font-weight:600;color:var(--t);margin-bottom:3px}
.donut-detail{font-size:11px;color:var(--tm)}

/* ── Data rows ── */
.row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);font-size:13px}
.row:last-child{border-bottom:none}
.lbl{color:var(--td);font-size:12px}
.val{color:var(--t);font-weight:600;font-size:12px;text-align:right}
.val.ok{color:var(--green)}.val.warn{color:var(--amber)}.val.err{color:var(--red)}.val.dim{color:var(--tm)}

/* ── Source pills ── */
.sources{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}
.src-pill{display:flex;align-items:center;gap:5px;padding:4px 11px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid}
.src-pill.up{color:var(--green);border-color:rgba(52,211,153,.3);background:rgba(52,211,153,.08)}
.src-pill.down{color:var(--red);border-color:rgba(239,68,68,.3);opacity:.65}
.src-pill.cb{color:var(--amber);border-color:rgba(252,184,89,.3);background:rgba(252,184,89,.08)}
.src-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}

/* ── OpenSky accounts ── */
.acct-table{display:flex;flex-direction:column;gap:0}
.acct-hd-row{display:grid;grid-template-columns:160px 90px 1fr 80px;gap:12px;padding:0 0 8px;border-bottom:1px solid var(--border);font-size:10px;font-weight:600;color:var(--td);text-transform:uppercase;letter-spacing:.08em}
.acct-row{display:grid;grid-template-columns:160px 90px 1fr 80px;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);align-items:center;font-size:12px}
.acct-row:last-child{border-bottom:none}
.acct-row.is-active .acct-name{color:var(--teal);font-weight:600}
.acct-name{font-weight:500;color:var(--t);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acct-status{display:flex;align-items:center;gap:6px}
.acct-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.acct-bar-wrap{height:5px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden}
.acct-bar-fill{height:100%;border-radius:3px;transition:width 1s cubic-bezier(.4,0,.2,1)}
.acct-credits{font-weight:600;text-align:right;color:var(--t)}

/* ── Hardware info strip ── */
.hw-strip{background:var(--panel2);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px}
.hw-model{font-weight:600;color:var(--t);margin-bottom:3px}
.hw-detail{color:var(--td);font-size:11px}

/* ── Spark canvas ── */
.spark-bg{background:rgba(255,255,255,0.03);border-radius:4px}

/* ── Footer ── */
.page-footer{padding:14px 24px;border-top:1px solid var(--border);font-size:11px;color:var(--td);flex-shrink:0;display:flex;align-items:center;justify-content:space-between;background:var(--bg)}

/* ── Responsive ── */
@media(max-width:1100px){.kpi-grid{grid-template-columns:repeat(3,1fr)}.sidebar{width:180px;min-width:180px}}
@media(max-width:800px){
  .sidebar{display:none}
  .grid-2,.grid-3{grid-template-columns:1fr}
  .kpi-grid{grid-template-columns:repeat(2,1fr)}
  .topbar{padding:0 16px}
  .topbar-title{font-size:13px}
  .topbar-sub{display:none}
  .btn-back{font-size:11px;padding:5px 10px}
  .sync-badge{font-size:11px}
  .mob-nav{display:flex}
}
@media(max-width:480px){
  .kpi-grid{grid-template-columns:1fr 1fr}
  .topbar-right{gap:6px}
  .btn-back span{display:none}
}
.mob-nav{display:none;overflow-x:auto;gap:8px;padding:10px 16px;background:var(--s);border-bottom:1px solid var(--border);scrollbar-width:none}
.mob-nav::-webkit-scrollbar{display:none}
.mob-nav a{flex-shrink:0;font-size:11px;font-weight:600;color:var(--td);text-decoration:none;padding:5px 12px;border-radius:20px;border:1px solid var(--border);white-space:nowrap;transition:all .2s}
.mob-nav a:hover,.mob-nav a.active{background:var(--teal);color:#171821;border-color:var(--teal)}
.mon-table{width:100%;border-collapse:collapse;font-size:12px}
.mon-table th{text-align:left;padding:8px 12px;color:var(--td);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid var(--border)}
.mon-table td{padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
.mon-table tr:last-child td{border-bottom:none}
.mon-table tr:hover td{background:rgba(255,255,255,.03)}
.mon-btn{font-size:11px;font-weight:600;padding:4px 10px;border-radius:6px;border:1px solid rgba(169,223,216,.3);background:rgba(169,223,216,.08);color:var(--teal);cursor:pointer;transition:all .15s;margin-right:4px}
.mon-btn:hover{background:rgba(169,223,216,.18)}
.mon-btn-danger{border-color:rgba(248,113,113,.3);background:rgba(248,113,113,.08);color:#f87171}
.mon-btn-danger:hover{background:rgba(248,113,113,.2)}
.mon-btn-warning{border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.08);color:#f59e0b}
.mon-btn-warning:hover{background:rgba(245,158,11,.2)}
</style>
</head>
<body>
<div class="layout">

  <!-- ── Sidebar ── -->
  <aside class="sidebar">
    <div class="sb-brand">
      <svg class="sb-brand-icon" viewBox="0 0 24 24" fill="none" stroke="#a9dfd8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>
      <div>
        <div class="sb-brand-text">AEROSTRAT</div>
        <div class="sb-brand-ver">${AEROSTRAT_VERSION}</div>
      </div>
    </div>
    <nav class="sb-nav">
      <div class="sb-section-lbl">Overview</div>
      <a class="sb-nav-item active" href="#kpi" onclick="setActive(this)">
        <span class="sb-nav-icon"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></span> Dashboard
      </a>
      <div class="sb-divider"></div>
      <div class="sb-section-lbl">System</div>
      <a class="sb-nav-item" href="#hardware" onclick="setActive(this)">
        <span class="sb-nav-icon"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg></span> Hardware
      </a>
      <a class="sb-nav-item" href="#storage" onclick="setActive(this)">
        <span class="sb-nav-icon"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg></span> Storage
      </a>
      <div class="sb-divider"></div>
      <div class="sb-section-lbl">Operations</div>
      <a class="sb-nav-item" href="#opensky" onclick="setActive(this)">
        <span class="sb-nav-icon"><svg viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L21 8l-3-3"/></svg></span> OpenSky Pool
      </a>
      <a class="sb-nav-item" href="#sync" onclick="setActive(this)">
        <span class="sb-nav-icon"><svg viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg></span> Sync Engine
      </a>
      <a class="sb-nav-item" href="#synclog" onclick="setActive(this)">
        <span class="sb-nav-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span> Sync Log
      </a>
      <a class="sb-nav-item" href="#sessions" onclick="setActive(this)">
        <span class="sb-nav-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg></span> Sessions
      </a>
      <a class="sb-nav-item" href="#api" onclick="setActive(this)">
        <span class="sb-nav-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></span> API Analytics
      </a>
    </nav>
    <div class="sb-footer">AEROSTRAT Hybrid Dynamics</div>
  </aside>

  <!-- ── Main ── -->
  <div class="main">
    <!-- Topbar -->
    <div class="topbar">
      <div class="topbar-left">
        <div class="topbar-title">System Monitor</div>
        <div class="topbar-sub" id="last-updated">Loading...</div>
      </div>
      <div class="topbar-right">
        <div class="sync-badge">
          <span class="sync-dot" id="sync-dot"></span>
          <span id="sync-label">Connecting...</span>
        </div>
        <a class="btn-back" href="javascript:void(0)" onclick="goBackToRadar()">← Back to Radar</a>
        <a class="btn-back" href="/monitor/logout" style="margin-left:8px;color:#f87171;border-color:rgba(239,68,68,0.3)">Logout</a>
      </div>
    </div>

    <!-- 手機版橫向導覽（≤800px sidebar 隱藏時顯示） -->
    <nav class="mob-nav">
      <a href="#kpi" class="active">Overview</a>
      <a href="#hw">Hardware</a>
      <a href="#storage">Storage</a>
      <a href="#opensky">OpenSky</a>
      <a href="#sync">Sync</a>
      <a href="#sessions">Sessions</a>
      <a href="#api">API</a>
    </nav>

    <!-- Scroll area -->
    <div class="scroll">

      <!-- KPI Cards -->
      <div id="kpi">
        <div class="section-hd">Overview</div>
        <div class="kpi-grid" id="stat-bar">
          <div class="kpi-card c-teal"><div class="kpi-lbl">AIRCRAFT</div><div class="skel"></div><div class="kpi-trend">In-memory cache</div></div>
          <div class="kpi-card c-green"><div class="kpi-lbl">SYNC CYCLES</div><div class="skel"></div><div class="kpi-trend">&mdash;</div></div>
          <div class="kpi-card c-amber"><div class="kpi-lbl">TRACK DOTS</div><div class="skel"></div><div class="kpi-trend">24h persistence</div></div>
          <div class="kpi-card c-purple"><div class="kpi-lbl">UPTIME</div><div class="skel"></div><div class="kpi-trend">System age</div></div>
          <div class="kpi-card c-red"><div class="kpi-lbl">DB SIZE</div><div class="skel"></div><div class="kpi-trend">SQLite storage</div></div>
        </div>
      </div>

      <!-- Hardware + Storage -->
      <div class="grid-2">
        <div id="hardware" class="card">
          <div class="card-hd">
            <span class="card-title">System Resources</span>
            <span class="card-badge" id="hw-badge">LIVE</span>
          </div>
          <div class="card-body" style="padding:14px 16px">
            <div id="hw-strip" class="hw-strip" style="margin-bottom:14px"></div>

            <!-- CPU sparkline -->
            <div style="margin-bottom:14px">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
                <span style="font-size:11px;font-weight:600;color:var(--td);letter-spacing:.08em;text-transform:uppercase">CPU</span>
                <span id="cpu-pct" style="font-size:18px;font-weight:700;color:#a9dfd8">--%</span>
              </div>
              <canvas id="cpu-spark" height="40" style="width:100%;display:block;border-radius:4px"></canvas>
              <div id="cpu-detail" style="font-size:10px;color:var(--td);margin-top:4px">load: —</div>
            </div>

            <!-- RAM sparkline -->
            <div style="margin-bottom:14px">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
                <span style="font-size:11px;font-weight:600;color:var(--td);letter-spacing:.08em;text-transform:uppercase">RAM</span>
                <span id="ram-pct" style="font-size:18px;font-weight:700;color:#fcb859">--%</span>
              </div>
              <canvas id="ram-spark" height="40" style="width:100%;display:block;border-radius:4px"></canvas>
              <div id="ram-detail" style="font-size:10px;color:var(--td);margin-top:4px">heap: —</div>
            </div>

            <!-- Memory breakdown bars -->
            <div id="mem-bars"></div>
          </div>
        </div>

        <div id="storage" class="card">
          <div class="card-hd">
            <span class="card-title">Disk &amp; Storage</span>
            <span class="card-badge">v10.5 HYBRID</span>
          </div>
          <div class="card-body">
            <div class="bar-row" style="margin-bottom:20px">
              <div class="bar-hd"><span class="bar-lbl">Disk Usage (/)</span><span id="disk-val">...</span></div>
              <div class="bar-bg"><div id="disk-bar" class="bar-fill" style="background:#a855f7"></div></div>
            </div>
            <div id="storage-body"></div>
          </div>
        </div>
      </div>

      <!-- Database Status -->
      <div id="dbstatus" class="card">
        <div class="card-hd">
          <span class="card-title">Database Status</span>
          <span class="card-badge" id="db-badge">—</span>
        </div>
        <div class="card-body">
          <div class="grid-2" style="gap:12px;margin-bottom:16px">
            <div>
              <div class="section-hd" style="font-size:11px;margin-bottom:8px">aerostrat.db（主要）</div>
              <div id="db-main-body"></div>
            </div>
            <div>
              <div class="section-hd" style="font-size:11px;margin-bottom:8px">routes.db（航線）</div>
              <div id="db-routes-body"></div>
            </div>
          </div>
          <div class="section-hd" style="font-size:11px;margin-bottom:8px">同步狀態</div>
          <div id="db-sync-body"></div>
        </div>
      </div>

      <!-- OpenSky Accounts -->
      <div id="opensky" class="card">
        <div class="card-hd">
          <span class="card-title">OpenSky Account Pool</span>
          <span class="card-badge" id="acct-badge">— Accounts</span>
        </div>
        <div class="card-body">
          <div class="acct-table">
            <div class="acct-hd-row">
              <span>Account</span><span>Status</span><span>Quota</span><span>Credits</span>
            </div>
            <div id="accounts-body"></div>
          </div>
        </div>
      </div>

      <!-- Sync + Sessions + API -->
      <div class="grid-3">
        <div id="sync" class="card">
          <div class="card-hd">
            <span class="card-title">Sync Engine</span>
            <span class="card-badge" id="sync-badge">—</span>
          </div>
          <div class="card-body">
            <div id="sources-bar" class="sources"></div>
            <div id="sync-body"></div>
          </div>
        </div>
        <div id="synclog" class="card">
          <div class="card-hd">
            <span class="card-title">Sync Log</span>
            <span class="card-badge" id="synclog-badge">live</span>
          </div>
          <div class="card-body">
            <div id="synclog-body" style="font-family:monospace;font-size:11px;max-height:220px;overflow-y:auto;color:var(--td)"></div>
          </div>
        </div>
        <div id="sessions" class="card">
          <div class="card-hd">
            <span class="card-title">Active Sessions</span>
            <span class="card-badge" id="session-badge">—</span>
          </div>
          <div class="card-body" id="session-body"></div>
        </div>
        <div id="api" class="card">
          <div class="card-hd">
            <span class="card-title">API Analytics</span>
            <span class="card-badge" id="api-badge">—</span>
          </div>
          <div class="card-body" id="api-body"></div>
        </div>
      </div>

    </div><!-- /scroll -->

    <div class="page-footer">
      <span>AEROSTRAT Hybrid Dynamics &nbsp;·&nbsp; 2026</span>
      <a href="?token=dev">Refresh</a>
    </div>
  </div><!-- /main -->

</div><!-- /layout -->

<script>
// ── Sparkline history (60 points = 60 × 5s = 5 min) ──────────────────────────
const SPARK_MAX  = 60;
const sparkData  = { cpu: [], ram: [] };

function pushSpark(key, val) {
  sparkData[key].push(val);
  if (sparkData[key].length > SPARK_MAX) sparkData[key].shift();
}

function drawSpark(canvasId, data, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth  || 300;
  const H   = canvas.offsetHeight || 40;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // background
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 4);
  ctx.fill();

  if (data.length < 2) return;

  const step   = W / (SPARK_MAX - 1);
  const pad    = 4;
  const usable = H - pad * 2;

  // gradient fill
  const grad = ctx.createLinearGradient(0, pad, 0, H);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');

  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (SPARK_MAX - data.length + i) * step;
    const y = pad + usable * (1 - v / 100);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  // close fill path
  const lastX = (SPARK_MAX - data.length + data.length - 1) * step;
  ctx.lineTo(lastX, H);
  ctx.lineTo((SPARK_MAX - data.length) * step, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // line
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (SPARK_MAX - data.length + i) * step;
    const y = pad + usable * (1 - v / 100);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // latest value dot
  const lastV = data[data.length - 1];
  const dotX  = (SPARK_MAX - 1) * step;
  const dotY  = pad + usable * (1 - lastV / 100);
  ctx.beginPath();
  ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function setDonut(id, pct) {} // legacy no-op (donuts replaced by sparklines)

function setActive(el) {
  document.querySelectorAll('.sb-nav-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
}

function row(lbl, val, cls) {
  return '<div class="row"><span class="lbl">' + lbl + '</span><span class="val ' + (cls||'') + '">' + val + '</span></div>';
}
function statCard(val, lbl, cls, trend) {
  return '<div class="kpi-card ' + cls + '"><div class="kpi-lbl">' + lbl + '</div><div class="kpi-val">' + val + '</div><div class="kpi-trend">' + (trend||'') + '</div></div>';
}
function srcPill(name, status) {
  return '<div class="src-pill ' + status + '"><span class="src-dot"></span>' + name + '</div>';
}
function formatBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

async function refresh() {
  try {
    const [health, stats] = await Promise.all([
      fetch('/api/health').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
    ]);

    const dot = document.getElementById('sync-dot');
    dot.className = 'sync-dot ok';
    document.getElementById('sync-label').textContent = 'Real-time connected';
    document.getElementById('last-updated').textContent = 'Updated: ' + new Date().toLocaleTimeString();

    const ing  = health.ingestion  || {};
    const perf = health.performance || {};
    const stor = health.storage     || {};
    const sys  = perf.system        || {};

    // ── KPI Cards ──
    const upSec = health.uptime || 0;
    const upStr = upSec >= 3600
      ? Math.floor(upSec/3600) + 'h ' + Math.floor((upSec%3600)/60) + 'm'
      : Math.floor(upSec/60) + ' min';
    const startedAt = new Date(Date.now() - upSec * 1000);
    const startedStr = (startedAt.getMonth()+1).toString().padStart(2,'0') + '/'
      + startedAt.getDate().toString().padStart(2,'0') + ' '
      + startedAt.getHours().toString().padStart(2,'0') + ':'
      + startedAt.getMinutes().toString().padStart(2,'0');

    document.getElementById('stat-bar').innerHTML =
      statCard((health.cacheSize||0).toLocaleString(), 'AIRCRAFT', 'c-teal', 'In-memory cache') +
      statCard('#' + (ing.totalBatches||0), 'SYNC CYCLES', 'c-green', (ing.lastBatchMs||0) + 'ms last latency') +
      statCard((ing.totalPoints||0).toLocaleString(), 'TRACK DOTS', 'c-amber', '24h persistence') +
      statCard(upStr, 'UPTIME', 'c-purple', 'Started ' + startedAt.toLocaleString('zh-TW', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false })) +
      statCard(formatBytes(stor.dbSize||0), 'DB SIZE', 'c-red', 'SQLite storage');

    // ── Hardware ──
    const cpuPct  = Math.min(100, Math.round(sys.cpuUsage || 0));
    const mem     = perf.process?.memory || {};
    const rss     = mem.rss     || 0;
    const heap    = mem.heapUsed || 0;
    const heapTot = mem.heapTotal || 0;
    const ext     = mem.external || 0;
    const totalMem = sys.totalMem || 8589934592;
    const freeMem  = sys.freeMem  || 0;
    const sysUsed  = totalMem - freeMem;
    const ramPct  = Math.min(100, Math.round((sysUsed / totalMem) * 100));

    pushSpark('cpu', cpuPct);
    pushSpark('ram', ramPct);
    drawSpark('cpu-spark', sparkData.cpu, '#a9dfd8');
    drawSpark('ram-spark', sparkData.ram, '#fcb859');

    document.getElementById('cpu-pct').textContent = cpuPct + '%';
    document.getElementById('ram-pct').textContent = ramPct + '%';
    document.getElementById('cpu-detail').textContent =
      'load avg  ' + (sys.load?.[0]||0).toFixed(2) + '  ' + (sys.load?.[1]||0).toFixed(2) + '  ' + (sys.load?.[2]||0).toFixed(2) +
      '  ·  ' + (sys.cpuCores||0) + ' cores';
    document.getElementById('ram-detail').textContent =
      'sys ' + formatBytes(sysUsed) + ' / ' + formatBytes(totalMem) +
      '  ·  proc rss ' + formatBytes(rss);

    document.getElementById('hw-strip').innerHTML =
      '<div class="hw-model">' + (sys.cpuModel || 'CPU') + '</div>' +
      '<div class="hw-detail">' + (sys.arch||'') + ' &nbsp;·&nbsp; ' + (sys.platform||'linux') + '</div>';

    document.getElementById('hw-badge').textContent = cpuPct + '% CPU · ' + ramPct + '% RAM';

    // Memory breakdown bars
    const mkBar = (lbl, used, total, color) => {
      const pct = Math.min(100, Math.round((used / (total||1)) * 100));
      return '<div class="bar-row"><div class="bar-hd"><span class="bar-lbl">' + lbl + '</span>' +
        '<span style="color:var(--tm);font-size:11px">' + formatBytes(used) + ' / ' + formatBytes(total) + ' &nbsp;<b style="color:' + color + '">' + pct + '%</b></span></div>' +
        '<div class="bar-bg"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
    };
    document.getElementById('mem-bars').innerHTML =
      mkBar('Heap Used',   heap,    heapTot,  '#a9dfd8') +
      mkBar('Heap Total',  heapTot, rss,      '#4ade80') +
      mkBar('RSS Memory',  rss,     totalMem, '#fcb859') +
      mkBar('System RAM',  sysUsed, totalMem, '#a855f7');

    // ── Disk ──
    const disk   = sys.disk || {};
    const diskPct = Math.round(((disk.used||0) / (disk.total||1)) * 100);
    document.getElementById('disk-val').textContent = formatBytes(disk.used) + ' / ' + formatBytes(disk.total);
    document.getElementById('disk-bar').style.width = diskPct + '%';
    document.getElementById('storage-body').innerHTML =
      row('Database', stor.dbPath || 'N/A', 'dim') +
      row('Mode', 'SQLite WAL', 'ok') +
      row('Sessions created', (ing.sessionsCreated||0).toLocaleString(), '') +
      row('Disk free', formatBytes(disk.free||0), 'ok');

    // ── OpenSky accounts ──
    const accts = stats.accounts || [];
    document.getElementById('acct-badge').textContent = accts.length + ' Accounts';
    document.getElementById('accounts-body').innerHTML = accts.map(a => {
      const pct   = Math.max(0, Math.min(100, Math.round((a.remainingCredits||0) / 4000 * 100)));
      const locked = a.unlockTime && new Date(a.unlockTime) > new Date();
      const isActive = a.user === health.activeAccount;
      const barColor = locked ? '#ef4444' : pct > 50 ? '#a9dfd8' : pct > 20 ? '#fcb859' : '#ef4444';
      const dotColor = locked ? '#ef4444' : '#34d399';
      const statusTxt = locked ? 'Locked' : isActive ? 'Active' : 'Standby';
      const shortName = (a.user||'').replace(/-api-client$/,'');
      return '<div class="acct-row' + (isActive?' is-active':'') + '">' +
        '<span class="acct-name">' + shortName + '</span>' +
        '<span class="acct-status"><span class="acct-dot" style="background:' + dotColor + '"></span><span style="color:' + dotColor + '">' + statusTxt + '</span></span>' +
        '<div class="acct-bar-wrap"><div class="acct-bar-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div>' +
        '<span class="acct-credits" style="color:' + barColor + '">' + (locked ? 'LOCKED' : (a.remainingCredits||0).toLocaleString()) + '</span>' +
        '</div>';
    }).join('');

    // ── Sync ──
    const sh = stats.sourceHealth || {};
    const now = Date.now();

    function srcStatus(key) {
      const s = sh[key] || {};
      if (s.cbUntil && s.cbUntil > now) return 'cb';
      if (s.consecutiveFails > 0) return 'warn';
      if (s.lastOk && (now - s.lastOk) < 120000) return 'up';
      return 'dim';
    }

    function srcDetail(key) {
      const s = sh[key] || {};
      const parts = [];
      if (s.lastCount) parts.push(s.lastCount.toLocaleString() + ' ac');
      if (s.lastLatency) parts.push(s.lastLatency + 'ms');
      if (s.cbUntil && s.cbUntil > now) {
        const minLeft = Math.round((s.cbUntil - now) / 60000);
        parts.push('CB ' + minLeft + 'min');
      }
      return parts.join(' · ');
    }

    document.getElementById('sources-bar').innerHTML =
      srcPill('adsb.fi-snap', srcStatus('adsb.fi-snap')) +
      srcPill('adsb.lol', srcStatus('adsb.lol')) +
      srcPill('al-mil', srcStatus('al-mil')) +
      srcPill('al-ladd', srcStatus('al-ladd')) +
      srcPill('OpenSky', stats.activeAccount ? 'up' : 'dim');

    document.getElementById('sync-badge').textContent = 'Cycle #' + (ing.totalBatches||0);
    document.getElementById('sync-body').innerHTML =
      row('adsb.fi-snap', srcDetail('adsb.fi-snap') || '—', srcStatus('adsb.fi-snap') === 'up' ? 'ok' : 'warn') +
      row('adsb.lol', srcDetail('adsb.lol') || '—', srcStatus('adsb.lol') === 'up' ? 'ok' : 'warn') +
      row('al-mil', srcDetail('al-mil') || '—', srcStatus('al-mil') === 'up' ? 'ok' : 'dim') +
      row('al-ladd', srcDetail('al-ladd') || '—', srcStatus('al-ladd') === 'up' ? 'ok' : 'dim') +
      row('Last batch', (ing.lastBatchSize||0) + ' planes · ' + (ing.lastBatchMs||0) + 'ms', (ing.lastBatchMs||0) < 3000 ? 'ok' : 'warn') +
      row('Active account', (stats.activeAccount||'—').replace(/-api-client$/,''), '');

    // ── Sync Log ──
    const logEl = document.getElementById('synclog-body');
    if (logEl) {
      const ts = new Date().toLocaleTimeString('zh-TW', {hour12:false});
      const sources = Object.entries(sh).map(([k,v]) => {
        const ok = !v.cbUntil || v.cbUntil <= now;
        const icon = ok ? '✅' : '🔴';
        const detail = v.lastCount ? v.lastCount.toLocaleString() + 'ac ' + (v.lastLatency||0) + 'ms' : (v.cbUntil > now ? 'CB' : '—');
        return icon + ' ' + k + ': ' + detail;
      }).join(' | ');
      const line = document.createElement('div');
      line.style.cssText = 'padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05)';
      line.textContent = '[' + ts + '] ' + sources;
      logEl.insertBefore(line, logEl.firstChild);
      // 最多保留 50 行
      while (logEl.children.length > 50) logEl.removeChild(logEl.lastChild);
    }

    // ── Sessions ──
    document.getElementById('session-badge').textContent = (health.activeSessions||0) + ' active';
    document.getElementById('session-body').innerHTML =
      row('Active', (health.activeSessions||0).toLocaleString(), 'ok') +
      row('Created', (ing.sessionsCreated||0).toLocaleString(), '') +
      row('Closed', (ing.sessionsClosed||0).toLocaleString(), 'dim');

    // ── API ──
    document.getElementById('api-badge').textContent = (stats.totalCalls||0).toLocaleString() + ' calls';
    document.getElementById('api-body').innerHTML =
      row('Total calls', (stats.totalCalls||0).toLocaleString(), '') +
      row('Cache hit rate', Math.round(((stats.cacheHits||0) / (stats.totalCalls||1)) * 100) + '%', 'ok') +
      row('Errors', (stats.errors||0), stats.errors > 0 ? 'err' : 'ok') +
      row('Uptime', Math.round((Date.now() - (stats.startTime||Date.now())) / 60000) + ' min', 'dim');

    // ── DB Status ──
    try {
      const dbSt = await fetch('/monitor/api/db-status').then(r => r.json());
      const m = dbSt.main   || {};
      const r2 = dbSt.routes || {};
      const syn = dbSt.sync  || {};

      const fmtRows = n => n == null ? '—' : Number(n).toLocaleString();
      const fmtMb   = n => n == null ? '—' : n + ' MB';

      // Main DB
      const mt = m.tables || {};
      document.getElementById('db-main-body').innerHTML =
        row('aerostrat.db', formatBytes(m.sizeBytes||0), 'dim') +
        row('track_points',    fmtRows(mt.track_points?.rows)    + ' · ' + fmtMb(mt.track_points?.sizeMb),    'warn') +
        row('flight_sessions', fmtRows(mt.flight_sessions?.rows) + ' · ' + fmtMb(mt.flight_sessions?.sizeMb), '') +
        row('users',           fmtRows(mt.users?.rows), 'dim');

      // Routes DB
      const rt = r2.tables || {};
      document.getElementById('db-routes-body').innerHTML =
        row('routes.db', formatBytes(r2.sizeBytes||0), 'dim') +
        row('routes',      fmtRows(rt.routes?.rows)      + ' 筆', 'ok') +
        row('airports',    fmtRows(rt.airports?.rows)    + ' 筆', 'ok') +
        row('airlines',    fmtRows(rt.airlines?.rows)    + ' 筆', 'ok') +
        row('model_types', fmtRows(rt.model_types?.rows) + ' 筆', 'ok');

      // Sync status
      const vrs  = syn.vrs  || {};
      const mict = syn.mictronics || {};
      const statusBadge = s => s === 'ok' ? 'ok' : s === 'syncing' ? 'warn' : s === 'error' ? 'err' : 'dim';
      const fmtDate = iso => iso ? new Date(iso).toLocaleString('zh-TW', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '未知';
      const mictDate = mict.lastSyncUnix ? new Date(mict.lastSyncUnix * 1000).toLocaleString('zh-TW', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '未知';

      document.getElementById('db-sync-body').innerHTML =
        row('VRS 航線 (每日)', fmtDate(vrs.lastSync) + ' · ' + (vrs.gitCommit||'—'), statusBadge(vrs.status)) +
        row('Mictronics (每週)', mictDate, statusBadge(mict.status));

      const totalRows = (mt.track_points?.rows||0) + (mt.flight_sessions?.rows||0);
      document.getElementById('db-badge').textContent = totalRows.toLocaleString() + ' rows';
    } catch(_) {}

  } catch(e) {
    const dot = document.getElementById('sync-dot');
    dot.className = 'sync-dot err';
    document.getElementById('sync-label').textContent = 'Connection lost';
    console.error(e);
  }
}

function goBackToRadar() {
  const radarUrl = window.location.protocol + '//' + window.location.hostname + ':3005';
  if (window.opener && !window.opener.closed) {
    try { window.opener.focus(); window.close(); }
    catch(e) { window.location.href = radarUrl; }
  } else {
    window.location.href = radarUrl;
  }
}

// Sidebar scroll-spy
const observer = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      const id = e.target.id;
      document.querySelectorAll('.sb-nav-item').forEach(item => {
        const href = item.getAttribute('href');
        item.classList.toggle('active', href === '#' + id);
      });
    }
  });
}, { root: document.querySelector('.scroll'), threshold: 0.4 });

document.addEventListener('DOMContentLoaded', () => {
  ['kpi','hardware','storage','dbstatus','opensky','sync','synclog','sessions','api'].forEach(id => {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  });
});

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}

module.exports = { getMonitorHtml };
