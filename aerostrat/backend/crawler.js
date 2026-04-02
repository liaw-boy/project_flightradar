const mongoose = require('mongoose');
const config = require('./config');

const Route = require('./models/Route');

// MOTC TDX API 端點 (桃園機場 TPE 為例)
const TPE_ARRIVAL_URL = 'https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Airport/Arrival/TPE?$format=JSON';
const TPE_DEPARTURE_URL = 'https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Airport/Departure/TPE?$format=JSON';

/**
 * [OAUTH2] 獲取 TDX API 存取權杖
 */
async function getTDXAccessToken() {
    const clientId = process.env.TDX_CLIENT_ID?.trim();
    const clientSecret = process.env.TDX_CLIENT_SECRET?.trim();

    if (!clientId || !clientSecret || clientId === 'YOUR_CLIENT_ID_HERE') {
        throw new Error('Please set TDX_CLIENT_ID and TDX_CLIENT_SECRET in .env');
    }

    const authUrl = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
    });

    const res = await fetch(authUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`TDX Auth failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.access_token;
}

/**
 * [CRAWLER] 航班報到爬蟲引擎
 * 模擬抓取機場官網資料，並將其同化至 AEROSTRAT 的 Route 庫中。
 */
async function crawlFlightSchedules() {
    console.log(`[${new Date().toLocaleTimeString()}] 🚀 [CRAWLER] Starting TPE schedule sync...`);
    
    try {
        // 0. 獲取 Token
        const token = await getTDXAccessToken();

        // 1. 抓取抵台 (Arrivals) 與 離台 (Departures) 資料
        const [arrRes, depRes] = await Promise.all([
            fetch(TPE_ARRIVAL_URL, { headers: { 'Authorization': `Bearer ${token}` } }),
            fetch(TPE_DEPARTURE_URL, { headers: { 'Authorization': `Bearer ${token}` } })
        ]);

        if (!arrRes.ok || !depRes.ok) {
            throw new Error(`TDX API returned error: ARR ${arrRes.status}, DEP ${depRes.status}`);
        }

        const arrivals = await arrRes.json();
        const departures = await depRes.json();

        console.log(`[CRAWLER] Fetched ${arrivals.length} arrivals and ${departures.length} departures.`);

        // 2. 數據清洗與同化
        const routeData = {};

        // 處理抵台：起飛港 -> TPE
        arrivals.forEach(f => {
            const callsign = (f.AirlineID + f.FlightNumber).trim().toUpperCase();
            if (!callsign || !f.DepartureAirportID) return;
            routeData[callsign] = {
                dep: f.DepartureAirportID,
                arr: 'RCTP', // 抵達港即為 TPE
                source: 'local_crawler'
            };
        });

        // 處理離台：TPE -> 抵達港
        departures.forEach(f => {
            const callsign = (f.AirlineID + f.FlightNumber).trim().toUpperCase();
            if (!callsign || !f.ArrivalAirportID) return;
            
            // 如果同時出現在 Arrivals 和 Departures，以後者（離程）為準或更新
            routeData[callsign] = {
                dep: 'RCTP',
                arr: f.ArrivalAirportID,
                source: 'local_crawler'
            };
        });

        const totalEntries = Object.keys(routeData).length;
        console.log(`[CRAWLER] Processed ${totalEntries} unique callsign routes.`);

        // 3. 寫入 MongoDB
        if (mongoose.connection.readyState !== 1) {
            const MONGODB_URI = config.MONGODB_URI;
            await mongoose.connect(MONGODB_URI);
        }

        let updateCount = 0;
        for (const [callsign, info] of Object.entries(routeData)) {
            await Route.findOneAndUpdate(
                { callsign },
                { 
                    departureAirport: info.dep, 
                    arrivalAirport: info.arr,
                    source: info.source,
                    lastUpdated: new Date()
                },
                { upsert: true }
            );
            updateCount++;
        }

        console.log(`[CRAWLER] Successfully synced ${updateCount} routes to MongoDB.`);
        
    } catch (err) {
        console.error(`[CRAWLER] Sync failed:`, err.message);
    }
}

// 如果是直接執行此腳本 (node crawler.js)
if (require.main === module) {
    crawlFlightSchedules().then(() => {
        console.log(`[CRAWLER] Done. Disconnecting...`);
        mongoose.disconnect();
    });
}

module.exports = { crawlFlightSchedules };
