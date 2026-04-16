'use strict';
/**
 * vrsDb.js — SQLite-backed lookup for VRS standing-data.
 *
 * Tables: routes / airports / airlines / model_types
 * Built by scripts/syncVrsRoutes.js from:
 *   https://github.com/vradarserver/standing-data (CC0, daily updates)
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'routes.db');

let db = null;
let stmtRoute      = null;
let stmtAirportIcao = null;
let stmtAirportIata = null;
let stmtAirline     = null;
let stmtAirlineIata = null;
let stmtModelType  = null;

function init() {
    if (!fs.existsSync(DB_PATH)) {
        console.warn('[VRS] routes.db not found — run scripts/syncVrsRoutes.js to build it');
        return;
    }
    try {
        db = new Database(DB_PATH, { readonly: true });
        db.pragma('cache_size = -16000'); // 16MB cache
        db.pragma('query_only = true');

        stmtRoute       = db.prepare('SELECT airline_icao, flight_number, airports FROM routes WHERE callsign = ?');
        stmtAirportIcao = db.prepare('SELECT code,name,icao,iata,lat,lng,country_iso FROM airports WHERE icao = ?');
        stmtAirportIata = db.prepare('SELECT code,name,icao,iata,lat,lng,country_iso FROM airports WHERE iata = ?');
        stmtAirline     = db.prepare('SELECT name,icao,iata FROM airlines WHERE icao = ? OR code = ?');
        stmtAirlineIata = db.prepare('SELECT name,icao,iata FROM airlines WHERE iata = ?');
        stmtModelType   = db.prepare('SELECT manufacturer,model,engine_count,engine_type,wtc,species FROM model_types WHERE icao = ?');

        // Check if new tables exist (built by updated syncVrsRoutes.js)
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        if (!tables.includes('airports')) {
            stmtAirportIcao = null;
            stmtAirportIata = null;
            stmtAirline     = null;
            stmtModelType   = null;
        }
    } catch (e) {
        console.warn('[VRS] DB init error:', e.message);
    }
}

init();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up departure/arrival airports by callsign.
 * Returns { from, to, raw, airline_icao } or null.
 * Handles leading zeros: EVA026 → EVA26
 */
function lookup(callsign) {
    if (!db || !stmtRoute || !callsign) return null;
    try {
        const cs = callsign.toUpperCase().trim();
        let row = stmtRoute.get(cs);
        if (!row) {
            const m = cs.match(/^([A-Z]{2,3})0+(\d+)$/);
            if (m) row = stmtRoute.get(m[1] + m[2]);
        }
        if (!row) return null;
        const parts = row.airports.split('-');
        return {
            from:         parts[0] || null,
            to:           parts[parts.length - 1] || null,
            raw:          row.airports,
            airline_icao: row.airline_icao || null,
        };
    } catch (_) { return null; }
}

/**
 * Look up airport info by ICAO or IATA code.
 * Returns { name, icao, iata, lat, lng, country_iso } or null.
 */
function lookupAirport(code) {
    if (!db || !code) return null;
    const c = code.toUpperCase().trim();
    try {
        const row = c.length === 4
            ? stmtAirportIcao?.get(c)
            : stmtAirportIata?.get(c);
        return row || null;
    } catch (_) { return null; }
}

/**
 * Look up airline name by ICAO code.
 * Returns { name, icao, iata } or null.
 */
function lookupAirline(icao) {
    if (!db || !stmtAirline || !icao) return null;
    try {
        const c = icao.toUpperCase().trim();
        return stmtAirline.get(c, c) || null;
    } catch (_) { return null; }
}

/** Look up airline by IATA code (e.g. 'CI' → { name, icao: 'CAL', iata: 'CI' }) */
function lookupAirlineByIata(iata) {
    if (!db || !stmtAirlineIata || !iata) return null;
    try {
        return stmtAirlineIata.get(iata.toUpperCase().trim()) || null;
    } catch (_) { return null; }
}

/**
 * Look up model type info by ICAO type code.
 * Returns { manufacturer, model, engine_count, engine_type, wtc, species } or null.
 */
function lookupModelType(typeCode) {
    if (!db || !stmtModelType || !typeCode) return null;
    try {
        return stmtModelType.get(typeCode.toUpperCase().trim()) || null;
    } catch (_) { return null; }
}

/**
 * Reload the DB after a sync (hot-reload without restart).
 */
function reload() {
    if (db) { try { db.close(); } catch (_) {} }
    db = null;
    stmtRoute = stmtAirportIcao = stmtAirportIata = stmtAirline = stmtModelType = null;
    init();
}

module.exports = { lookup, lookupAirport, lookupAirline, lookupAirlineByIata, lookupModelType, reload };
