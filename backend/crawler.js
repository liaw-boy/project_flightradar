'use strict';
const Route     = require('./db/routeStore');
const logger    = require('./logger');
const syncLog   = require('./db/syncLogger');

// TDX API base
const TDX_BASE = 'https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Airport';

// 台灣主要機場 — 只爬有大量國際航班的機場以節省 TDX 點數
// 離島/小機場的班次極少，adsbdb.com 已能覆蓋，不需要 TDX
const TW_AIRPORTS = [
    { iata: 'TPE', icao: 'RCTP' }, // 桃園國際（最多班次）
    { iata: 'TSA', icao: 'RCSS' }, // 台北松山（兩岸/日韓）
    { iata: 'KHH', icao: 'RCKH' }, // 高雄小港（國際線）
    { iata: 'RMQ', icao: 'RCMQ' }, // 台中清泉崗（國際線）
];

async function getTDXAccessToken() {
    const clientId = process.env.TDX_CLIENT_ID?.trim();
    const clientSecret = process.env.TDX_CLIENT_SECRET?.trim();

    if (!clientId || !clientSecret || clientId === 'YOUR_CLIENT_ID_HERE') {
        throw new Error('TDX_CLIENT_ID / TDX_CLIENT_SECRET not configured');
    }

    const res = await fetch(
        'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret,
            }).toString(),
            signal: AbortSignal.timeout(10000),
        }
    );

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`TDX Auth failed (${res.status}): ${errText}`);
    }

    return (await res.json()).access_token;
}

async function fetchAirportFIDS(token, iata) {
    const [arrRes, depRes] = await Promise.allSettled([
        fetch(`${TDX_BASE}/Arrival/${iata}?$format=JSON`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
        }),
        fetch(`${TDX_BASE}/Departure/${iata}?$format=JSON`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
        }),
    ]);

    const arrivals  = arrRes.status  === 'fulfilled' && arrRes.value.ok  ? await arrRes.value.json()  : [];
    const departures = depRes.status === 'fulfilled' && depRes.value.ok  ? await depRes.value.json() : [];
    return { arrivals, departures };
}

async function crawlFlightSchedules() {
    logger.info('CRAWLER', `Starting TDX schedule sync (${TW_AIRPORTS.length} airports)`);
    syncLog.start('tdx');

    let token;
    try {
        token = await getTDXAccessToken();
    } catch (err) {
        logger.error('CRAWLER', `Auth failed: ${err.message}`);
        syncLog.fail('tdx', `TDX auth failed: ${err.message}`);
        return;
    }

    // 循序抓取，每次間隔 1.5 秒，避免 burst 觸發 TDX rate limit（免費帳號 50 req/s per IP）
    const results = [];
    for (const ap of TW_AIRPORTS) {
        const r = await fetchAirportFIDS(token, ap.iata)
            .then(data => ({ status: 'fulfilled', value: { ...data, ap } }))
            .catch(err => ({ status: 'rejected', reason: err }));
        results.push(r);
        await new Promise(res => setTimeout(res, 1500));
    }

    const routeData = {};

    for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { arrivals, departures, ap } = r.value;

        // 抵達：外站 → 台灣機場
        for (const f of arrivals) {
            const cs = buildCallsign(f);
            if (!cs || !f.DepartureAirportID) continue;
            // 用 IATA 轉 ICAO（若查得到），否則直接存 IATA
            routeData[cs] = {
                dep: f.DepartureAirportID,
                arr: ap.icao,
                source: 'tdx',
            };
        }

        // 出發：台灣機場 → 外站
        for (const f of departures) {
            const cs = buildCallsign(f);
            if (!cs || !f.ArrivalAirportID) continue;
            routeData[cs] = {
                dep: ap.icao,
                arr: f.ArrivalAirportID,
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
    const raw = ((f.AirlineID || '') + (f.FlightNumber || '')).trim().toUpperCase();
    return raw.replace(/[^A-Z0-9]/g, '') || null;
}

if (require.main === module) {
    crawlFlightSchedules().then(() => console.log('[CRAWLER] Done.'));
}

module.exports = { crawlFlightSchedules };
