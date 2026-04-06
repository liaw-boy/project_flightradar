'use strict';
/**
 * mictronicsDb.js — SQLite-backed lookup for the Mictronics Aircraft Registry.
 *
 * The mictronics_aircraft table is populated by scripts/syncMictronics.js
 * and refreshed weekly. It stores ~400k ICAO24→aircraft records.
 *
 * All lookups are synchronous (better-sqlite3) and very fast (primary key lookup).
 */
const db = require('./sqlite');

const stmtLookup = db.prepare(
    'SELECT icao24, registration, typecode, operator, model FROM mictronics_aircraft WHERE icao24 = ?'
);

const stmtCount = db.prepare('SELECT COUNT(*) as cnt FROM mictronics_aircraft');

const stmtLastSync = db.prepare('SELECT MAX(synced_at) as last FROM mictronics_aircraft');

/**
 * Look up aircraft by ICAO24 hex.
 * Returns { icao24, registration, typecode, operator, model } or null.
 */
function lookup(icao24) {
    if (!icao24) return null;
    try {
        return stmtLookup.get(icao24.toLowerCase().trim()) || null;
    } catch (_) {
        return null;
    }
}

/**
 * Bulk upsert records.
 * records: Array of { icao24, registration, typecode, operator, model }
 */
function bulkUpsert(records) {
    const stmt = db.prepare(`
        INSERT INTO mictronics_aircraft (icao24, registration, typecode, operator, model, synced_at)
        VALUES (?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(icao24) DO UPDATE SET
            registration = excluded.registration,
            typecode     = excluded.typecode,
            operator     = excluded.operator,
            model        = excluded.model,
            synced_at    = excluded.synced_at
    `);

    const insertMany = db.transaction((rows) => {
        for (const r of rows) {
            stmt.run(
                r.icao24  || null,
                r.registration || null,
                r.typecode     || null,
                r.operator     || null,
                r.model        || null
            );
        }
    });

    insertMany(records);
}

/** Total record count. */
function count() {
    try {
        return stmtCount.get().cnt;
    } catch (_) {
        return 0;
    }
}

/** Unix timestamp of the last sync, or null. */
function lastSyncTime() {
    try {
        return stmtLastSync.get().last || null;
    } catch (_) {
        return null;
    }
}

module.exports = { lookup, bulkUpsert, count, lastSyncTime };
