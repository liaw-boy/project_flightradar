'use strict';
const fs   = require('fs');
const path = require('path');
const db   = require('../db/sqlite');

// ── Airport JSON (same source as globalAirportsDB in server.js) ──────────────
const AIRPORTS_FILE = path.join(__dirname, '..', 'data', 'processed', 'airports_global.json');
let _airportsJson = null;
function airportsJson() {
    if (!_airportsJson) {
        try { _airportsJson = JSON.parse(fs.readFileSync(AIRPORTS_FILE, 'utf8')); }
        catch (_) { _airportsJson = {}; }
    }
    return _airportsJson;
}

// ── Haversine distance (km) ──────────────────────────────────────────────────

function haversine(lat1, lng1, lat2, lng2) {
    const R  = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Airport coords lookup ─────────────────────────────────────────────────────

function getAirportCoords(icao) {
    if (!icao) return null;
    const ap = airportsJson()[icao.toUpperCase()];
    if (!ap || ap.lat == null) return null;
    // airports_global.json uses 'lon' field
    return { lat: ap.lat, lng: ap.lon ?? ap.lng };
}

// ── GET /api/flights/my ──────────────────────────────────────────────────────

function list(req, res) {
    const userId = req.user.id;
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) AS n FROM user_flights WHERE user_id = ?').get(userId).n;
    const rows  = db.prepare(
        `SELECT * FROM user_flights WHERE user_id = ?
         ORDER BY flight_date DESC, id DESC
         LIMIT ? OFFSET ?`
    ).all(userId, limit, offset);

    res.json({ total, page, limit, flights: rows });
}

// ── POST /api/flights/my ─────────────────────────────────────────────────────

function create(req, res) {
    const userId = req.user.id;
    const {
        flight_date, flight_number, callsign, icao24, aircraft_type,
        registration, dep_icao, arr_icao, dep_time, arr_time,
        seat_number, seat_class, notes
    } = req.body || {};

    if (!flight_date) return res.status(400).json({ error: 'flight_date required' });

    const info = db.prepare(`
        INSERT INTO user_flights
            (user_id, flight_date, flight_number, callsign, icao24, aircraft_type,
             registration, dep_icao, arr_icao, dep_time, arr_time,
             seat_number, seat_class, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
        userId, flight_date, flight_number || null, callsign || null,
        icao24 || null, aircraft_type || null, registration || null,
        dep_icao ? dep_icao.toUpperCase() : null,
        arr_icao ? arr_icao.toUpperCase() : null,
        dep_time || null, arr_time || null,
        seat_number || null, seat_class || null, notes || null
    );

    const created = db.prepare('SELECT * FROM user_flights WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ flight: created });
}

// ── PUT /api/flights/my/:id ──────────────────────────────────────────────────

function update(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const row    = db.prepare('SELECT * FROM user_flights WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) return res.status(404).json({ error: 'flight not found' });

    const fields = [
        'flight_date','flight_number','callsign','icao24','aircraft_type',
        'registration','dep_icao','arr_icao','dep_time','arr_time',
        'seat_number','seat_class','notes'
    ];
    const updates = {};
    for (const f of fields) {
        if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (Object.keys(updates).length === 0)
        return res.status(400).json({ error: 'nothing to update' });

    updates.updated_at = Math.floor(Date.now() / 1000);
    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE user_flights SET ${sets} WHERE id = ? AND user_id = ?`)
      .run(...Object.values(updates), id, userId);

    const updated = db.prepare('SELECT * FROM user_flights WHERE id = ?').get(id);
    res.json({ flight: updated });
}

// ── DELETE /api/flights/my/:id ───────────────────────────────────────────────

function remove(req, res) {
    const { id } = req.params;
    const userId = req.user.id;
    const info = db.prepare('DELETE FROM user_flights WHERE id = ? AND user_id = ?').run(id, userId);
    if (info.changes === 0) return res.status(404).json({ error: 'flight not found' });
    res.json({ ok: true });
}

// ── GET /api/flights/my/stats ────────────────────────────────────────────────

function stats(req, res) {
    const userId = req.user.id;
    const flights = db.prepare(
        'SELECT * FROM user_flights WHERE user_id = ? ORDER BY flight_date DESC'
    ).all(userId);

    let totalKm = 0;
    const airports  = new Set();
    const countries = new Set();
    const aircraftCount = {};
    const routeCount    = {};

    for (const f of flights) {
        if (f.dep_icao) airports.add(f.dep_icao);
        if (f.arr_icao) airports.add(f.arr_icao);
        if (f.aircraft_type) aircraftCount[f.aircraft_type] = (aircraftCount[f.aircraft_type] || 0) + 1;

        // distance
        if (f.dep_icao && f.arr_icao) {
            const dep = getAirportCoords(f.dep_icao);
            const arr = getAirportCoords(f.arr_icao);
            if (dep && arr) {
                totalKm += haversine(dep.lat, dep.lng, arr.lat, arr.lng);
                const route = [f.dep_icao, f.arr_icao].sort().join('-');
                routeCount[route] = (routeCount[route] || 0) + 1;
            }
        }
    }

    // top aircraft
    const topAircraft = Object.entries(aircraftCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type, count]) => ({ type, count }));

    // top routes
    const topRoutes = Object.entries(routeCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([route, count]) => ({ route, count }));

    res.json({
        total_flights: flights.length,
        total_km:      Math.round(totalKm),
        total_airports: airports.size,
        top_aircraft:  topAircraft,
        top_routes:    topRoutes,
        recent:        flights.slice(0, 5)
    });
}

// ── GET /api/flights/my/map ──────────────────────────────────────────────────

function mapData(req, res) {
    const userId = req.user.id;
    const flights = db.prepare(
        'SELECT dep_icao, arr_icao, flight_number, flight_date, aircraft_type FROM user_flights WHERE user_id = ? AND dep_icao IS NOT NULL AND arr_icao IS NOT NULL'
    ).all(userId);

    const routes = [];
    for (const f of flights) {
        const dep = getAirportCoords(f.dep_icao);
        const arr = getAirportCoords(f.arr_icao);
        if (dep && arr) {
            routes.push({
                dep_icao:     f.dep_icao,
                arr_icao:     f.arr_icao,
                dep_lat:      dep.lat,
                dep_lng:      dep.lng,
                arr_lat:      arr.lat,
                arr_lng:      arr.lng,
                flight_number: f.flight_number,
                flight_date:  f.flight_date,
                aircraft_type: f.aircraft_type
            });
        }
    }
    res.json({ routes });
}

module.exports = { list, create, update, remove, stats, mapData };
