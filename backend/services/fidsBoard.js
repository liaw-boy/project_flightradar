'use strict';
// Live arrivals/departures board (機場起降看板) — separate from crawler.js's
// route-dictionary sync. crawler.js runs once a day and only keeps
// {departureAirport, arrivalAirport} for route lookups; this module keeps the
// full FIDS record (times, terminal, gate, status) refreshed every 5 minutes
// so /api/fids/board can serve an actual live board, not just yesterday's
// route shape.
const logger = require('../logger');

const TDX_BASE = 'https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Airport';
const REFRESH_MS = 5 * 60 * 1000; // 5 minutes — FIDS remarks/times update continuously

// Board airports — same set crawler.js covers, but this module fetches
// independently (different cadence, different payload shape) rather than
// sharing crawler.js's daily cycle.
const BOARD_AIRPORTS = [
    { iata: 'TPE', icao: 'RCTP', name: '桃園國際機場' },
];

let _cache = {}; // iata -> { arrivals: [...], departures: [...], updatedAt: ISOString }
let _tokenCache = { token: null, expiresAt: 0 };

async function getTDXAccessToken() {
    const now = Date.now();
    if (_tokenCache.token && now < _tokenCache.expiresAt) return _tokenCache.token;

    const clientId = process.env.TDX_CLIENT_ID?.trim();
    const clientSecret = process.env.TDX_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new Error('TDX_CLIENT_ID / TDX_CLIENT_SECRET not configured');

    const res = await fetch(
        'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
            signal: AbortSignal.timeout(10000),
        }
    );
    if (!res.ok) throw new Error(`TDX Auth failed (${res.status})`);
    const data = await res.json();
    _tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in ? data.expires_in * 1000 - 30000 : 15 * 60 * 1000) };
    return _tokenCache.token;
}

function normalizeArrival(f) {
    return {
        flightNo: `${f.AirlineID || ''}${f.FlightNumber || ''}`,
        airline: f.AirlineID || null,
        from: f.DepartureAirportID || null,
        scheduleTime: f.ScheduleArrivalTime || null,
        actualTime: f.ActualArrivalTime || null,
        estimatedTime: f.EstimatedArrivalTime || null,
        remark: f.ArrivalRemark || null,
        terminal: f.Terminal || null,
        gate: (f.Gate || '').trim() || null,
        baggageClaim: f.BaggageClaim || null,
        acType: f.AcType || null,
        isCargo: !!f.IsCargo,
    };
}

function normalizeDeparture(f) {
    return {
        flightNo: `${f.AirlineID || ''}${f.FlightNumber || ''}`,
        airline: f.AirlineID || null,
        to: f.ArrivalAirportID || null,
        scheduleTime: f.ScheduleDepartureTime || null,
        actualTime: f.ActualDepartureTime || null,
        estimatedTime: f.EstimatedDepartureTime || null,
        remark: f.DepartureRemark || null,
        terminal: f.Terminal || null,
        gate: (f.Gate || '').trim() || null,
        checkInCounter: f.CheckCounter || null,
        acType: f.AcType || null,
        isCargo: !!f.IsCargo,
    };
}

async function fetchBoardForAirport(token, iata) {
    const [arrRes, depRes] = await Promise.allSettled([
        fetch(`${TDX_BASE}/Arrival/${iata}?$format=JSON`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
        }),
        fetch(`${TDX_BASE}/Departure/${iata}?$format=JSON`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
        }),
    ]);

    const arrRaw = arrRes.status === 'fulfilled' && arrRes.value.ok ? await arrRes.value.json() : [];
    const depRaw = depRes.status === 'fulfilled' && depRes.value.ok ? await depRes.value.json() : [];

    return {
        arrivals: (arrRaw || []).map(normalizeArrival),
        departures: (depRaw || []).map(normalizeDeparture),
        updatedAt: new Date().toISOString(),
    };
}

async function refreshFidsBoard() {
    let token;
    try {
        token = await getTDXAccessToken();
    } catch (e) {
        logger.warn('FIDS', `Token error: ${e.message}`);
        return;
    }

    for (const ap of BOARD_AIRPORTS) {
        try {
            const board = await fetchBoardForAirport(token, ap.iata);
            _cache[ap.iata] = board;
            logger.debug('FIDS', `${ap.iata} board refreshed: ${board.arrivals.length} arrivals, ${board.departures.length} departures`);
        } catch (e) {
            logger.warn('FIDS', `Board fetch failed for ${ap.iata}: ${e.message}`);
        }
    }
}

function getFidsBoard(iata) {
    return _cache[iata?.toUpperCase()] || null;
}

function listBoardAirports() {
    return BOARD_AIRPORTS;
}

function startFidsBoardSync() {
    refreshFidsBoard();
    setInterval(refreshFidsBoard, REFRESH_MS);
}

module.exports = { startFidsBoardSync, getFidsBoard, listBoardAirports, refreshFidsBoard };
