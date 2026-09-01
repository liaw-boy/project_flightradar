'use strict';
const Route     = require('./db/routeStore');
const logger    = require('./logger');
const syncLog   = require('./db/syncLogger');

// [2026-08-31] Was calling TDX directly here (own getTDXAccessToken/
// fetchAirportFIDS). Root-caused: this project and the separately-run
// tpe_flight_board project (same machine, port 3800) both independently
// polled the exact same 4 airports under the SAME TDX member account —
// combined usage exceeded TDX's account-level quota and got BOTH registered
// clients suspended ("超量使用停權"). Fix: read tpe_flight_board's
// already-crawled data over HTTP instead of hitting TDX a second time here
// (services/fidsBoard.js got the same fix for its own separate TDX caller).
const TPE_FLIGHT_BOARD_URL = process.env.TPE_FLIGHT_BOARD_URL || 'http://127.0.0.1:3800';

// 台灣主要機場 — 只爬有大量國際航班的機場以節省 TDX 點數
// 離島/小機場的班次極少，adsbdb.com 已能覆蓋，不需要 TDX
const TW_AIRPORTS = [
    { iata: 'TPE', icao: 'RCTP' }, // 桃園國際（最多班次）
    { iata: 'TSA', icao: 'RCSS' }, // 台北松山（兩岸/日韓）
    { iata: 'KHH', icao: 'RCKH' }, // 高雄小港（國際線）
    { iata: 'RMQ', icao: 'RCMQ' }, // 台中清泉崗（國際線）
];

async function fetchAirportFIDS(iata) {
    const qs = `airport=${iata}&all=1&cargo=1`;
    const [arrRes, depRes] = await Promise.allSettled([
        fetch(`${TPE_FLIGHT_BOARD_URL}/api/flights?direction=arrival&${qs}`, { signal: AbortSignal.timeout(8000) }),
        fetch(`${TPE_FLIGHT_BOARD_URL}/api/flights?direction=departure&${qs}`, { signal: AbortSignal.timeout(8000) }),
    ]);

    const arrJson = arrRes.status === 'fulfilled' && arrRes.value.ok ? await arrRes.value.json() : null;
    const depJson = depRes.status === 'fulfilled' && depRes.value.ok ? await depRes.value.json() : null;
    return { arrivals: arrJson?.flights || [], departures: depJson?.flights || [] };
}

async function crawlFlightSchedules() {
    logger.info('CRAWLER', `Starting TDX-derived schedule sync via tpe_flight_board (${TW_AIRPORTS.length} airports)`);
    syncLog.start('tdx');

    // Sequential with a short gap is no longer about respecting TDX's own
    // rate limit (tpe_flight_board owns that now) — just gentle pacing
    // against a local service that's also serving live traffic.
    const results = [];
    for (const ap of TW_AIRPORTS) {
        const r = await fetchAirportFIDS(ap.iata)
            .then(data => ({ status: 'fulfilled', value: { ...data, ap } }))
            .catch(err => ({ status: 'rejected', reason: err }));
        results.push(r);
        await new Promise(res => setTimeout(res, 300));
    }

    const routeData = {};

    for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { arrivals, departures, ap } = r.value;

        // 抵達：外站 → 台灣機場
        for (const f of arrivals) {
            const cs = buildCallsign(f);
            if (!cs || !f.origin) continue;
            // 用 IATA 轉 ICAO（若查得到），否則直接存 IATA
            routeData[cs] = {
                dep: f.origin,
                arr: ap.icao,
                source: 'tdx',
            };
        }

        // 出發：台灣機場 → 外站
        for (const f of departures) {
            const cs = buildCallsign(f);
            if (!cs || !f.destination) continue;
            routeData[cs] = {
                dep: ap.icao,
                arr: f.destination,
                source: 'tdx',
            };
        }
    }

    const total = Object.keys(routeData).length;
    logger.info('CRAWLER', `Processed ${total} unique callsign routes from TDX`);

    if (total === 0) {
        syncLog.fail('tdx', 'TDX returned 0 routes — all airports may have failed');
        return;
    }

    // 批次寫入 RouteStore
    let updated = 0;
    for (const [callsign, info] of Object.entries(routeData)) {
        try {
            await Route.findOneAndUpdate(
                { callsign },
                { $set: { callsign, departureAirport: info.dep, arrivalAirport: info.arr, source: info.source } },
                { upsert: true, returnDocument: 'after' }
            );
            updated++;
        } catch (_) { /* 單筆失敗不中止 */ }
    }

    logger.info('CRAWLER', `Synced ${updated}/${total} routes to RouteStore`);
    syncLog.success('tdx', `${updated} routes`);
}

function buildCallsign(f) {
    // f.flightNumber already comes pre-combined (airlineId + number) from
    // tpe_flight_board's /api/flights.
    const raw = (f.flightNumber || '').trim().toUpperCase();
    return raw.replace(/[^A-Z0-9]/g, '') || null;
}

if (require.main === module) {
    crawlFlightSchedules().then(() => console.log('[CRAWLER] Done.'));
}

module.exports = { crawlFlightSchedules };
