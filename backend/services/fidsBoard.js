'use strict';
// Live arrivals/departures board (機場起降看板) — separate from crawler.js's
// route-dictionary sync. crawler.js runs once a day and only keeps
// {departureAirport, arrivalAirport} for route lookups; this module keeps the
// full FIDS record (times, terminal, gate, status, codeshares) refreshed
// every 5 minutes so /api/flights can serve an actual live board.
//
// Field names/behavior (status classification, codeshare grouping, search,
// terminal/airline/cargo filters, freshness buffer) are ported from the
// author's standalone tpe_flight_board project — this keeps that project's
// preferred UX/data shape while staying a single AEROSTRAT service rather
// than a second deployment.
const logger = require('../logger');
const { AIRLINES } = require('../data/tpeAirlines');

// [2026-08-31] Was calling TDX directly here. Root-caused: this project and
// the separately-run tpe_flight_board project (same machine, port 3800) both
// independently polled the exact same 4 airports under the SAME TDX member
// account — combined usage exceeded TDX's account-level quota and got BOTH
// registered clients suspended ("超量使用停權"), not just this one. Fix:
// tpe_flight_board already crawls TDX and exposes the result over HTTP —
// read that instead of hitting TDX a second time for identical data.
const TPE_FLIGHT_BOARD_URL = process.env.TPE_FLIGHT_BOARD_URL || 'http://127.0.0.1:3800';
const REFRESH_MS = 5 * 60 * 1000; // 5 minutes — FIDS remarks/times update continuously
const BUFFER_MINUTES = 10; // live view hides flights more than this far in the past

const BOARD_AIRPORTS = [
    { code: 'TPE', name: '桃園國際機場' },
    { code: 'TSA', name: '台北松山機場' },
    { code: 'KHH', name: '高雄小港機場' },
    { code: 'RMQ', name: '台中機場' },
];

let _cache = {}; // code -> { arrivals: [raw], departures: [raw], updatedAt: ISOString }

function clean(value) {
    if (value == null) return null;
    const trimmed = String(value).trim();
    if (!trimmed || trimmed === '-' || trimmed === '--') return null;
    return trimmed;
}

// tpe_flight_board's /api/flights already serializes+groups codeshares
// server-side, but its field names line up with this module's own "raw"
// shape closely enough to feed straight into the serialize()/groupCodeshares()
// pipeline below unchanged — the only fields it doesn't carry (flightDate,
// isCargo) aren't load-bearing here (isCargo defaults false since we always
// request cargo=1 below, so nothing downstream would need to filter it out).
function fromTpeFlightBoardRecord(item, direction) {
    return {
        direction,
        flightDate: (item.scheduledTime || '').slice(0, 10) || null,
        flightNumber: item.flightNumber,
        airlineId: item.airlineId,
        origin: item.origin,
        destination: item.destination,
        scheduledTime: item.scheduledTime || null,
        actualTime: item.actualTime || null,
        estimatedTime: item.estimatedTime || null,
        remark: item.remark || null,
        terminal: item.terminal || null,
        gate: item.gate || null,
        acType: item.acType || null,
        baggageClaim: item.baggageClaim || null,
        checkCounter: item.checkCounter || null,
        isCargo: false,
        updateTime: item.updateTime || null,
    };
}

async function fetchBoardForAirport(code) {
    // all=1 + cargo=1: ask for the full unfiltered day's data — this
    // module's own queryFlights() below re-applies the buffer/cargo/terminal
    // filters, so we want tpe_flight_board's raw superset here, not its
    // already-buffer-filtered live view.
    const qs = `airport=${code}&all=1&cargo=1`;
    const [arrRes, depRes] = await Promise.allSettled([
        fetch(`${TPE_FLIGHT_BOARD_URL}/api/flights?direction=arrival&${qs}`, { signal: AbortSignal.timeout(8000) }),
        fetch(`${TPE_FLIGHT_BOARD_URL}/api/flights?direction=departure&${qs}`, { signal: AbortSignal.timeout(8000) }),
    ]);

    const arrJson = arrRes.status === 'fulfilled' && arrRes.value.ok ? await arrRes.value.json() : null;
    const depJson = depRes.status === 'fulfilled' && depRes.value.ok ? await depRes.value.json() : null;
    if (!arrJson && !depJson) throw new Error('tpe_flight_board unreachable for both directions');

    return {
        arrivals: (arrJson?.flights || []).map(f => fromTpeFlightBoardRecord(f, 'arrival')),
        departures: (depJson?.flights || []).map(f => fromTpeFlightBoardRecord(f, 'departure')),
        updatedAt: new Date().toISOString(),
    };
}

async function refreshFidsBoard() {
    for (const ap of BOARD_AIRPORTS) {
        try {
            const board = await fetchBoardForAirport(ap.code);
            _cache[ap.code] = board;
            logger.debug('FIDS', `${ap.code} board refreshed: ${board.arrivals.length} arrivals, ${board.departures.length} departures`);
        } catch (e) {
            logger.warn('FIDS', `Board fetch failed for ${ap.code}: ${e.message}`);
        }
    }
}

// ── Status classification (ported from tpe_flight_board/routes/api.js) ─────
function computeStatus(f) {
    const remark = f.remark || '';
    if (remark.includes('取消')) return 'cancelled';
    if (remark.includes('延誤')) return 'delayed';
    if (remark.includes('登機')) return 'boarding';
    if (f.actualTime) return 'done';
    if (remark.includes('準時')) return 'ontime';
    if (f.estimatedTime && f.scheduledTime && f.estimatedTime !== f.scheduledTime) return 'delayed';
    return 'ontime';
}

function airlineName(code) {
    return AIRLINES[code] || code || '—';
}

// city/name lookups are injected from server.js's already-loaded
// globalAirportsDB rather than duplicating that dataset here.
function serialize(row, airportLookup) {
    const originInfo = airportLookup?.(row.origin);
    const destInfo = airportLookup?.(row.destination);
    return {
        flightNumber: row.flightNumber,
        airlineId: row.airlineId,
        airlineName: airlineName(row.airlineId),
        origin: row.origin,
        originCity: originInfo?.city || originInfo?.name || null,
        destination: row.destination,
        destinationCity: destInfo?.city || destInfo?.name || null,
        scheduledTime: row.scheduledTime,
        estimatedTime: row.estimatedTime,
        actualTime: row.actualTime,
        remark: row.remark,
        status: computeStatus(row),
        terminal: row.terminal,
        gate: row.gate,
        acType: row.acType,
        baggageClaim: row.baggageClaim,
        checkCounter: row.checkCounter,
        updateTime: row.updateTime,
    };
}

// 把「同表定時間 + 同登機門 + 同航廈 + 同路線」的多筆航班視為代碼共享(同一實體航班),
// 合併成一筆,codeshares 帶出其他已知航班號。只有 gate/terminal 都有值時才合併,
// 避免把單純「都還沒分配登機門」的不同航班誤判成同一班。
function groupCodeshares(flights) {
    const groups = new Map();
    const order = [];
    for (const f of flights) {
        const key = f.gate && f.terminal
            ? [f.scheduledTime, f.terminal, f.gate, f.origin, f.destination].join('|')
            : `__solo__${f.flightNumber}|${f.scheduledTime}`;
        if (!groups.has(key)) { groups.set(key, []); order.push(key); }
        groups.get(key).push(f);
    }
    return order.map(key => {
        const group = groups.get(key);
        if (group.length === 1) return group[0];
        const primary = group.slice().sort((a, b) => (b.acType ? 1 : 0) - (a.acType ? 1 : 0))[0];
        const others = group.filter(f => f !== primary);
        return {
            ...primary,
            codeshares: others.map(f => ({ flightNumber: f.flightNumber, airlineId: f.airlineId, airlineName: f.airlineName })),
        };
    });
}

function todayTaipei() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// 回傳「現在時間往前推 N 分鐘」的 Taipei 本地時間字串(格式與 scheduledTime 一致: YYYY-MM-DDTHH:MM)
function nowMinusBufferTaipei(bufferMinutes) {
    const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Taipei',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const get = type => parts.find(p => p.type === type).value;
    const nowTaipei = new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00+08:00`);
    const shifted = new Date(nowTaipei.getTime() - bufferMinutes * 60 * 1000);
    return shifted.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T').slice(0, 16);
}

/**
 * queryFlights — filters + serializes the in-memory cache for one airport/direction.
 * opts: { code, direction, terminal, airline, cargo, history }
 */
function queryFlights(opts, airportLookup) {
    const board = _cache[opts.code];
    if (!board) return { flights: [], lastUpdated: null };

    const list = opts.direction === 'departure' ? board.departures : board.arrivals;
    const today = todayTaipei();
    const minTime = !opts.history ? nowMinusBufferTaipei(BUFFER_MINUTES) : null;

    let rows = list.filter(f => {
        if (!opts.cargo && f.isCargo) return false;
        if (!f.scheduledTime || !f.scheduledTime.startsWith(today)) return false;
        if (opts.terminal && f.terminal !== opts.terminal) return false;
        if (opts.airline && f.airlineId !== opts.airline) return false;
        if (minTime && f.scheduledTime < minTime) return false;
        if (!opts.history && f.status === 'cancelled') { /* still shown, just not hidden */ }
        return true;
    });

    let flights = groupCodeshares(rows.map(f => serialize(f, airportLookup)));

    if (opts.q) {
        const needle = opts.q.toLowerCase();
        flights = flights.filter(f => {
            const names = [f.flightNumber, f.airlineName, f.origin, f.originCity, f.destination, f.destinationCity]
                .concat((f.codeshares || []).map(c => c.flightNumber))
                .concat((f.codeshares || []).map(c => c.airlineName));
            return names.filter(Boolean).some(v => String(v).toLowerCase().includes(needle));
        });
    }

    return { flights, lastUpdated: board.updatedAt };
}

function getStats(opts, airportLookup) {
    const board = _cache[opts.code];
    if (!board) return { direction: opts.direction, total: 0, onTimeRate: 0, delayed: 0, cancelled: 0, done: 0 };

    const list = opts.direction === 'departure' ? board.departures : board.arrivals;
    const today = todayTaipei();
    const rows = list.filter(f => (opts.cargo || !f.isCargo) && f.scheduledTime && f.scheduledTime.startsWith(today));

    let delayed = 0, cancelled = 0, done = 0;
    for (const row of rows) {
        const status = computeStatus(row);
        if (status === 'delayed') delayed++;
        else if (status === 'cancelled') cancelled++;
        else if (status === 'done') done++;
    }
    const total = rows.length;
    const onTimeRate = total ? Math.round(((total - delayed - cancelled) / total) * 100) : 0;
    return { direction: opts.direction, total, onTimeRate, delayed, cancelled, done };
}

function listBoardAirports() {
    return BOARD_AIRPORTS.map(a => ({ code: a.code, name: a.name }));
}

function startFidsBoardSync() {
    refreshFidsBoard();
    setInterval(refreshFidsBoard, REFRESH_MS);
}

module.exports = { startFidsBoardSync, queryFlights, getStats, listBoardAirports, refreshFidsBoard };
