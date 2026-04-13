'use strict';
/**
 * vrsDb.js — SQLite-backed lookup for VRS standing-data routes.
 *
 * Database is built by scripts/build-routes-db.js from
 * https://github.com/vradarserver/standing-data
 *
 * Maps callsign → { airline_icao, flight_number, airports }
 * e.g. EVA771 → { airline_icao: 'EVA', flight_number: '771', airports: 'ZSSS-RCSS' }
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'routes.db');

let db = null;
let stmtLookup = null;

if (fs.existsSync(DB_PATH)) {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('cache_size = -8000'); // 8MB cache
    stmtLookup = db.prepare('SELECT airline_icao, flight_number, airports FROM routes WHERE callsign = ?');
} else {
    console.warn('[VRS] routes.db not found — run scripts/build-routes-db.js to build it');
}

/**
 * Look up departure/arrival airports by callsign.
 * Returns { from: 'ICAO', to: 'ICAO', raw: 'ICAO-ICAO' } or null if not found.
 * Handles leading zeros: EVA026 → tries EVA026, then EVA26.
 */
function lookup(callsign) {
    if (!db || !callsign) return null;
    try {
        const cs = callsign.toUpperCase().trim();
        let row = stmtLookup.get(cs);

        // Fallback: strip leading zeros from numeric suffix (EVA026 → EVA26)
        if (!row) {
            const match = cs.match(/^([A-Z]{2,3})0+(\d+)$/);
            if (match) row = stmtLookup.get(match[1] + match[2]);
        }

        if (!row) return null;
        const parts = row.airports.split('-');
        return { from: parts[0] || null, to: parts[parts.length - 1] || null, raw: row.airports };
    } catch (_) {
        return null;
    }
}

module.exports = { lookup };
