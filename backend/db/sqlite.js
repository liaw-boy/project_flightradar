'use strict';
/**
 * SQLite initializer — replaces MongoDB for TrackPoint + FlightSession.
 * Uses WAL mode for concurrent reads + better write throughput.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR  = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'aerostrat.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode: concurrent reads don't block writes
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -32000');   // 32MB page cache
db.pragma('temp_store = MEMORY');

// ── Flight Sessions ────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS flight_sessions (
    session_id       TEXT PRIMARY KEY,
    icao24           TEXT NOT NULL,
    callsign         TEXT,
    status           TEXT DEFAULT 'ACTIVE',
    start_time       INTEGER,
    end_time         INTEGER,
    departure_airport TEXT,
    arrival_airport  TEXT,
    created_at       INTEGER DEFAULT (unixepoch()),
    updated_at       INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_fs_status  ON flight_sessions(status);
CREATE INDEX IF NOT EXISTS idx_fs_icao24  ON flight_sessions(icao24);
CREATE INDEX IF NOT EXISTS idx_fs_callsign ON flight_sessions(callsign);
`);

// ── Track Points (append-only time-series) ────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS track_points (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT    NOT NULL,
    icao24        TEXT    NOT NULL,
    ts            INTEGER NOT NULL,
    lat           REAL,
    lng           REAL,
    altitude      REAL,
    velocity      REAL,
    heading       REAL,
    vertical_rate REAL,
    on_ground     INTEGER DEFAULT 0,
    squawk        TEXT,
    callsign      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tp_session ON track_points(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_tp_icao24  ON track_points(icao24);
CREATE INDEX IF NOT EXISTS idx_tp_ts      ON track_points(ts);
`);

// ── Mictronics Aircraft Registry (static, weekly sync) ───────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS mictronics_aircraft (
    icao24       TEXT PRIMARY KEY,
    registration TEXT,
    typecode     TEXT,
    operator     TEXT,
    model        TEXT,
    synced_at    INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_mic_typecode ON mictronics_aircraft(typecode);
`);

// ── User Accounts ─────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_color  TEXT DEFAULT '#4CAF50',
    created_at    INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
`);

// ── User Personal Flight Records ───────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS user_flights (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    flight_date   TEXT NOT NULL,
    flight_number TEXT,
    callsign      TEXT,
    icao24        TEXT,
    aircraft_type TEXT,
    registration  TEXT,
    dep_icao      TEXT,
    arr_icao      TEXT,
    dep_time      TEXT,
    arr_time      TEXT,
    seat_number   TEXT,
    seat_class    TEXT CHECK(seat_class IN ('economy','business','first','premium_economy')),
    notes         TEXT,
    created_at    INTEGER DEFAULT (unixepoch()),
    updated_at    INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_uf_user_id   ON user_flights(user_id);
CREATE INDEX IF NOT EXISTS idx_uf_date      ON user_flights(flight_date);
`);

// ── Batched TTL cleanup (24 h) — non-blocking, yields between chunks ─────
const PRUNE_BATCH = 5000;            // ~120ms DELETE blocks — short enough for healthy event loop
const PRUNE_PAUSE_MS = 500;          // 500ms pause — ample time for HTTP I/O between batches
const _pruneStmt = db.prepare(
    'DELETE FROM track_points WHERE rowid IN (SELECT rowid FROM track_points WHERE ts < ? LIMIT ?)'
);

function pruneOldTrackPoints() {
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
    let totalDeleted = 0;

    function batch() {
        try {
            const info = _pruneStmt.run(cutoff, PRUNE_BATCH);
            totalDeleted += info.changes;
            if (info.changes >= PRUNE_BATCH) {
                if (totalDeleted % 500000 === 0) {
                    console.log(`[SQLite] Prune progress: ${totalDeleted} rows deleted so far…`);
                }
                setTimeout(batch, PRUNE_PAUSE_MS);
            } else {
                if (totalDeleted > 0) {
                    console.log(`[SQLite] Pruned ${totalDeleted} track points older than 24h`);
                }
                db.pragma('wal_checkpoint(PASSIVE)');
            }
        } catch (e) {
            console.error('[SQLite] Prune batch error:', e.message);
        }
    }
    batch();
}

// ── Periodic WAL checkpoint — every 5 minutes ────────────────────────────
function walCheckpoint() {
    try {
        const result = db.pragma('wal_checkpoint(PASSIVE)');
        const r = result[0];
        if (r && r.log > 0) {
            console.log(`[SQLite] WAL checkpoint: ${r.busy} busy, ${r.log} log pages, ${r.checkpointed} checkpointed`);
        }
    } catch (e) {
        console.error('[SQLite] WAL checkpoint error:', e.message);
    }
}

// ── ANALYZE — update query planner statistics (every 6 hours) ───────────────
// Keeps SQLite's query planner accurate after large inserts/deletes.
// Much cheaper than VACUUM — no page rewrite, typically <100ms.
function analyzeDb() {
    try {
        db.exec('ANALYZE');
        console.log('[SQLite] ANALYZE complete');
    } catch (e) {
        console.error('[SQLite] ANALYZE error:', e.message);
    }
}

// ── VACUUM — reclaim freed pages (weekly, Sunday 04:00 local) ───────────────
// Only runs if DB has grown significantly fragmented (freelist_count > 10k pages).
// WAL mode: VACUUM rewrites the entire DB — schedule during low-traffic window.
function vacuumIfNeeded() {
    try {
        const freelistCount = db.pragma('freelist_count', { simple: true });
        if (freelistCount > 10000) {
            console.log(`[SQLite] VACUUM starting — ${freelistCount} free pages`);
            db.exec('VACUUM');
            console.log('[SQLite] VACUUM complete');
        }
    } catch (e) {
        console.error('[SQLite] VACUUM error:', e.message);
    }
}

// Defer startup prune 5s so server starts listening first
setTimeout(pruneOldTrackPoints, 5000);
setInterval(pruneOldTrackPoints, 3600 * 1000);
setInterval(walCheckpoint, 5 * 60 * 1000);
setInterval(analyzeDb, 6 * 3600 * 1000);

// Weekly VACUUM — Sunday 04:05 local (roughly; node timer drifts, cron in server.js handles precision)
const msUntilSunday4am = (() => {
    const now = new Date();
    const target = new Date(now);
    target.setHours(4, 5, 0, 0);
    const daysUntilSun = (7 - now.getDay()) % 7 || 7;
    target.setDate(target.getDate() + daysUntilSun);
    return target.getTime() - now.getTime();
})();
setTimeout(() => {
    vacuumIfNeeded();
    setInterval(vacuumIfNeeded, 7 * 24 * 3600 * 1000);
}, msUntilSunday4am);

module.exports = db;
