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
    squawk        TEXT
);
CREATE INDEX IF NOT EXISTS idx_tp_session ON track_points(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_tp_icao24  ON track_points(icao24);
CREATE INDEX IF NOT EXISTS idx_tp_ts      ON track_points(ts);
`);

// ── TTL cleanup (72 h) — run on startup and every hour ───────────────────
function pruneOldTrackPoints() {
    const cutoff = Math.floor(Date.now() / 1000) - 72 * 3600;
    const info = db.prepare('DELETE FROM track_points WHERE ts < ?').run(cutoff);
    if (info.changes > 0) {
        console.log(`[SQLite] Pruned ${info.changes} track points older than 24h`);
        db.pragma('wal_checkpoint(RESTART)');
    }
}
pruneOldTrackPoints();
setInterval(pruneOldTrackPoints, 3600 * 1000);

module.exports = db;
