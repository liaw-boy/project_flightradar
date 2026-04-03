'use strict';
/**
 * staticMaps — replaces MongoDB AirportDictionary, RouteDictionary, AircraftShape, Airline.
 * Data is loaded from CSV/JSON into in-memory Maps at startup.
 * O(1) lookup, zero DB overhead, zero TTL issues.
 */
const fs   = require('fs');
const path = require('path');

// ── Airport Dictionary ────────────────────────────────────────────────────
// Key: ICAO code (uppercase). Loaded from MongoDB export or CSV.
const airportByIcao = new Map();  // icao → { icao, iata, name, city, country, lat, lon }
const airportByIata = new Map();  // iata → same

// ── Route Dictionary ──────────────────────────────────────────────────────
// Key: normalized callsign. { callsign, originIata, destinationIata }
const routeByCallsign = new Map();

// ── Aircraft Shapes ───────────────────────────────────────────────────────
// Key: typecode (uppercase). Loaded from DB once at startup.
const shapeByTypecode = new Map();

// ── Airlines ──────────────────────────────────────────────────────────────
const airlineByIcao = new Map();

// ── Loaders ───────────────────────────────────────────────────────────────
/**
 * Load AirportDictionary CSV (ourairports format).
 * Expected columns: id, ident, type, name, latitude_deg, longitude_deg, iso_country, municipality, iata_code
 */
function loadAirportDictionaryFromCsv(csvPath) {
    if (!fs.existsSync(csvPath)) return 0;
    const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
    let loaded = 0;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
        const row  = Object.fromEntries(headers.map((h, j) => [h, cols[j] || '']));
        const icao = (row.ident || row.icao_code || '').toUpperCase();
        const iata = (row.iata_code || '').toUpperCase();
        if (!icao) continue;
        const entry = {
            icao,
            iata:    iata || null,
            name:    row.name || null,
            city:    row.municipality || null,
            country: row.iso_country || null,
            lat:     parseFloat(row.latitude_deg)  || null,
            lon:     parseFloat(row.longitude_deg) || null,
        };
        airportByIcao.set(icao, entry);
        if (iata) airportByIata.set(iata, entry);
        loaded++;
    }
    return loaded;
}

/**
 * Load RouteDictionary CSV (vrs-standing-data format or internal export).
 * Expected columns: Callsign,From,To  OR  callsign,originIata,destinationIata
 */
function loadRouteDictionaryFromCsv(csvPath) {
    if (!fs.existsSync(csvPath)) return 0;
    const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
    const rawHeader = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
    const ci = rawHeader.indexOf('callsign');
    const oi = rawHeader.findIndex(h => h.includes('origin') || h === 'from' || h === 'departureiata');
    const di = rawHeader.findIndex(h => h.includes('dest')   || h === 'to'   || h === 'arrivaliata');
    if (ci < 0) return 0;
    let loaded = 0;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
        const cs   = cols[ci]?.toUpperCase();
        if (!cs) continue;
        routeByCallsign.set(cs, {
            callsign:        cs,
            originIata:      oi >= 0 ? (cols[oi] || '').toUpperCase() : '',
            destinationIata: di >= 0 ? (cols[di] || '').toUpperCase() : '',
        });
        loaded++;
    }
    return loaded;
}

/** Load from pre-exported JSON arrays (fallback if CSV not available) */
function loadFromJson(jsonPath, type) {
    if (!fs.existsSync(jsonPath)) return 0;
    const arr = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    let loaded = 0;
    for (const item of arr) {
        if (type === 'airport') {
            const icao = (item.icao || item.ident || '').toUpperCase();
            const iata = (item.iata || item.iata_code || '').toUpperCase();
            if (!icao) continue;
            airportByIcao.set(icao, item);
            if (iata) airportByIata.set(iata, item);
        } else if (type === 'route') {
            const cs = (item.callsign || '').toUpperCase();
            if (cs) routeByCallsign.set(cs, item);
        } else if (type === 'shape') {
            const tc = (item.typecode || item.type_code || '').toUpperCase();
            if (tc) shapeByTypecode.set(tc, item);
        } else if (type === 'airline') {
            const ic = (item.icao || item.code || '').toUpperCase();
            if (ic) airlineByIcao.set(ic, item);
        }
        loaded++;
    }
    return loaded;
}

// ── Initialization ────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');

(function init() {
    // AirportDictionary
    const apCsvPath  = path.join(DATA_DIR, 'airports.csv');
    const apJsonPath = path.join(DATA_DIR, 'airport_dictionary.json');
    let n = loadAirportDictionaryFromCsv(apCsvPath);
    if (n === 0) n = loadFromJson(apJsonPath, 'airport');
    if (n > 0) console.log(`[StaticMaps] AirportDictionary: ${n} airports loaded`);

    // RouteDictionary
    const rtCsvPath  = path.join(DATA_DIR, 'routes.csv');
    const rtJsonPath = path.join(DATA_DIR, 'route_dictionary.json');
    let r = loadRouteDictionaryFromCsv(rtCsvPath);
    if (r === 0) r = loadFromJson(rtJsonPath, 'route');
    if (r > 0) console.log(`[StaticMaps] RouteDictionary: ${r} routes loaded`);

    // AircraftShape (loaded later by server.js from DB — just pre-init map here)
    const shapeJsonPath = path.join(DATA_DIR, 'aircraft_shapes.json');
    const ns = loadFromJson(shapeJsonPath, 'shape');
    if (ns > 0) console.log(`[StaticMaps] AircraftShape: ${ns} shapes loaded`);

    // Airline
    const airlineJsonPath = path.join(DATA_DIR, 'airlines.json');
    const na = loadFromJson(airlineJsonPath, 'airline');
    if (na > 0) console.log(`[StaticMaps] Airline: ${na} airlines loaded`);
})();

// ── API ───────────────────────────────────────────────────────────────────

/** AirportDictionary.findOne({ icao }) */
function airportFindOne(query) {
    if (query?.icao) return airportByIcao.get(query.icao.toUpperCase()) || null;
    if (query?.iata) return airportByIata.get(query.iata.toUpperCase()) || null;
    return null;
}

/** RouteDictionary.findOne({ callsign }) */
function routeDictFindOne(query) {
    const cs = (query?.callsign || '').toUpperCase();
    return routeByCallsign.get(cs) || null;
}

/** AircraftShape.find({}) — returns all shapes */
function shapeFind() {
    return Array.from(shapeByTypecode.values());
}

/** Populate shapes from external source (called by server.js after fetching from DB/files) */
function addShape(typecode, data) {
    if (typecode) shapeByTypecode.set(typecode.toUpperCase(), data);
}

/** Bulk-load shapes (replaces AircraftShape.find() → cache) */
function loadShapes(arr) {
    for (const s of arr) {
        const tc = (s.typecode || s.type_code || '').toUpperCase();
        if (tc) shapeByTypecode.set(tc, s);
    }
}

/** Populate airports from array (server.js loads from Airport DB/JSON) */
function loadAirports(arr) {
    for (const a of arr) {
        const icao = (a.icao || '').toUpperCase();
        const iata = (a.iata || '').toUpperCase();
        if (icao) airportByIcao.set(icao, a);
        if (iata) airportByIata.set(iata, a);
    }
}

/** Populate routes from array */
function loadRoutes(arr) {
    for (const r of arr) {
        const cs = (r.callsign || '').toUpperCase();
        if (cs) routeByCallsign.set(cs, r);
    }
}

module.exports = {
    // Mongoose-compatible query functions
    AirportDictionary: {
        findOne: (q) => Promise.resolve(airportFindOne(q)),
    },
    RouteDictionary: {
        findOne: (q) => Promise.resolve(routeDictFindOne(q)),
    },
    AircraftShape: {
        find: (_q, _proj) => Promise.resolve(shapeFind()),
    },
    // Bulk loaders
    loadShapes,
    loadAirports,
    loadRoutes,
    // Direct accessors
    getAirportByIcao: (icao) => airportByIcao.get((icao || '').toUpperCase()) || null,
    getAirportByIata: (iata) => airportByIata.get((iata || '').toUpperCase()) || null,
    getRoute: (callsign) => routeByCallsign.get((callsign || '').toUpperCase()) || null,
    getShape: (typecode) => shapeByTypecode.get((typecode || '').toUpperCase()) || null,
    addShape,
    airportCount: () => airportByIcao.size,
    routeCount:   () => routeByCallsign.size,
};
