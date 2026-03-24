const config = require('./config');
const logger = require('./logger'); // [LOG] Structured logger with file output

const express = require('express');
const cors = require('cors');
const compression = require('compression'); // [v2.9.0] Gzip
const helmet = require('helmet'); // [v3.0] Security headers
const rateLimit = require('express-rate-limit'); // [v3.0] API abuse protection
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { Worker } = require('worker_threads');
const http = require('http');
const zlib = require('zlib');
const readline = require('readline');
const { initWebSocketServer, broadcastPlanes, broadcastTelemetry, getActiveViewports } = require('./socketEngine');
const mongoose = require('mongoose'); // [Phase 15] Database Persistence
const Route = require('./models/Route'); // [Phase 15] Route Schema
const TrackPoint = require('./models/TrackPoint'); // [Time Series] Historical Tracks
const Aircraft = require('./models/Aircraft'); // [Cache Migration]
const Metar = require('./models/Metar'); // [Cache Migration]
const FlightSession = require('./models/FlightSession'); // [Flight Sessions]
const Airport = require('./models/Airport'); // [GIS Modernization]
const AircraftShape = require('./models/AircraftShape'); // [SVG Shapes]
const AircraftRegistry = require('./models/AircraftRegistry'); // [Registry Data]
const { crawlFlightSchedules } = require('./crawler'); // [CRAWLER] Real-time schedules
const NodeCache = require('node-cache'); // [v8.0] BFF Aggregator Cache
const ActiveFlight = require('./models/ActiveFlight'); // [Phase 12] High-Availability DB-First Live Data
const flightController = require('./controllers/flightController'); // [Phase 14] Ultimate Fusion Controller
const AEROSTRAT_VERSION = 'v10.5-Hybrid'; // [v10.5] Dual-Sync Engine

// ==========================================
// [v4.4.0] Logging Helper with Tactical Timestamps
// ==========================================
function getTime() {
    return `[${new Date().toLocaleTimeString('en-US', { hour12: false })}]`;
}


// ==========================================
// [Phase 15] MongoDB Connection (Local Only)
// ==========================================
// We default to local MongoDB to ensure privacy and speed.
const MONGODB_URI = config.MONGODB_URI;
logger.info('DATABASE', `Connecting to MongoDB: ${MONGODB_URI}`);

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    bufferTimeoutMS: 3000, // Fast-fail: stop buffering ops after 3s when disconnected
}).then(async () => {
    logger.info('DATABASE', '✅ Connected to MongoDB successfully');
    restoreActiveSessions();

    // [Phase 16] Run OSINT Data Sync immediately after connection
    const { initOsintData } = require('./scripts/syncOsintData');
    initOsintData();

    // [Phase 17] Mictronics Aircraft DB — runs after OSINT, non-blocking
    const { syncMictronics } = require('./scripts/syncMictronics');
    syncMictronics(msg => logger.info('MICTRONICS', msg)).catch(err =>
        logger.warn('MICTRONICS', `Sync failed (non-fatal): ${err.message}`)
    );

    // Sync TTL index to match schema (MongoDB won't auto-update existing TTL values)
    try {
        const db = mongoose.connection.db;
        await db.command({
            collMod: 'trackpoints',
            index: { keyPattern: { timestamp: 1 }, expireAfterSeconds: 172800 }
        });
        logger.info('DATABASE', 'TrackPoint TTL synced to 48 hours');
    } catch (ttlErr) {
        // Time-series collections manage TTL via expireAfterSeconds at creation, not collMod
        const ignored = ['NamespaceNotFound', 'IndexNotFound'];
        const isTimeseries = ttlErr.message && ttlErr.message.includes('time-series');
        if (!ignored.includes(ttlErr.codeName) && !isTimeseries) {
            logger.warn('DATABASE', `Could not sync TTL index: ${ttlErr.message}`);
        } else if (isTimeseries) {
            logger.debug('DATABASE', 'TrackPoint is time-series — TTL managed by collection options (skip collMod)');
        }
    }
})
    .catch(err => logger.error('DATABASE', `Connection failed: ${err.message}`));

mongoose.connection.on('error', err => {
    logger.error('DATABASE', `Runtime error: ${err.message}`);
});

mongoose.connection.on('disconnected', () => {
    logger.warn('DATABASE', 'MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
    logger.info('DATABASE', '✅ MongoDB reconnected');
    buildAirportListCache();
});

// ==========================================
// [v11.0] Fast Startup Metadata Index (500k records)
// ==========================================
const aircraftMetadataIndex = new Map(); // icao24 -> typecode

async function initAircraftMetadataIndex() {
    const csvPath = path.join(__dirname, 'data', 'aircraft.csv.gz');
    if (!fs.existsSync(csvPath)) {
        console.warn(`${getTime()} ⚠️ [INDEX] aircraft.csv.gz not found at ${csvPath}`);
        return;
    }

    console.log(`${getTime()} 📂 [INDEX] Building aircraft metadata index from ${csvPath}...`);
    const start = performance.now();

    return new Promise((resolve) => {
        const fileStream = fs.createReadStream(csvPath);
        const gunzip = zlib.createGunzip();
        const rl = readline.createInterface({
            input: fileStream.pipe(gunzip),
            crlfDelay: Infinity
        });

        let lineCount = 0;
        let indexedCount = 0;
        let headers = [];

        rl.on('line', (line) => {
            if (!line.trim()) return;
            lineCount++;

            // Format: icao24;registration;typecode;category;model (no header row, semicolon-delimited)
            const parts = line.split(';');
            const icao = parts[0]?.replace(/^"|"$/g, '').toLowerCase();
            const type = parts[2]?.replace(/^"|"$/g, '').toUpperCase();

            if (icao && type && type !== 'N/A' && type !== 'UNKNOWN' && type !== '') {
                aircraftMetadataIndex.set(icao, type);
                indexedCount++;
            }
        });

        rl.on('close', () => {
            const elapsed = ((performance.now() - start) / 1000).toFixed(2);
            console.log(`${getTime()} ✅ [INDEX] Indexed ${indexedCount} aircraft in ${elapsed}s (Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB)`);
            resolve();
        });
    });
}

// [OPT] Debounce utility — 合併高頻磁碟寫入
// ==========================================
function debounce(fn, delayMs) {
    let timer = null;
    return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn.apply(this, args);
        }, delayMs);
    };
}

const app = express();
app.set('trust proxy', 1); // Fix ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
const PORT = config.PORT;

// ==========================================
// Middleware
// ==========================================
app.use(cors());
app.use(compression()); // [v2.9.0] Gzip
app.use(logger.httpMiddleware); // [LOG] HTTP request logging (skips high-freq endpoints)

// [v5.0.0] Static file serving REMOVED — Frontend runs independently via Vite Dev Server
// Backend is now a pure API + WebSocket data engine

// [v12.5] Aircraft SVG silhouettes served locally (avoids GitHub CDN 404s/rate-limits)
app.use('/api/svg', express.static(path.join(__dirname, 'public/svg'), {
    maxAge: '7d',
    setHeaders: (res) => { res.setHeader('Access-Control-Allow-Origin', '*'); }
}));


// [v3.0] Security Headers
app.use(helmet({
    contentSecurityPolicy: false, // Prevents blocking of inline scripts and external map tiles
    crossOriginEmbedderPolicy: false, // Prevents blocking of external assets
}));
// Rate limiter: 200 req/min per IP（選飛機會同時觸發 metadata+route+track 3 個請求）
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please wait a moment.' },
    skip: (req) => ['/api/events', '/api/flights/live', '/api/flight-details', '/api/flight/complete-details'].some(p => req.path.startsWith(p)), // High-freq & Fusion exempt
});
app.use('/api', apiLimiter);
app.use(express.json());

// [v9.7] Strategic API Heartbeats
app.post('/api/viewport', (req, res) => res.json({ status: 'ok', received: true }));
app.get('/api/planes/bbox-ping', (req, res) => res.json({ status: 'active' }));

// ==========================================
// [v8.0] High-Availability Live Data Endpoint
// ==========================================
app.get('/api/flights/live', async (req, res) => {
    const { lamin, lomin, lamax, lomax } = req.query;
    
    // Normalize to standard JSON structure
    const normalize = (icao24, lat, lon, alt, hdg, gs, vrate, squawk, callsign, onGround, category, typecode) => ({
        hex: icao24?.toLowerCase() || 'unknown',
        lat: parseFloat(lat) || 0,
        lon: parseFloat(lon) || 0,
        alt: Math.round(alt) || 0,
        hdg: Math.round(hdg) || 0,
        gs: Math.round(gs) || 0,
        vrate: Math.round(vrate) || 0,
        squawk: squawk || '0000',
        callsign: (callsign || 'N/A').trim(),
        onGround: !!onGround,
        category: category || 0,
        typecode: typecode || null
    });

    try {
        // [Phase 17] Adaptive Primary Telemetry Resolver
        const primaryUrl = process.env.PRIMARY_TELEMETRY_URL || 'https://opensky-network.org/api/states/all';
        let rawPlanes = [];
        let sourceName = 'primary';

        if (primaryUrl.includes('opensky-network.org')) {
            // Format 1: OpenSky Network (Uses built-in credential rotator fetcher)
            const osData = await fetchOpenSky({ lamin, lomin, lamax, lomax });
            rawPlanes = osData.states.map(s => normalize(
                s.icao24, s.lat, s.lng, s.altitude, s.heading, 
                s.velocity, s.vRate, s.squawk, s.callsign, s.onGround,
                s.category, s.typecode
            ));
            sourceName = 'opensky';
        } else {
            // Format 2: Custom SDR JSON (Raspberry Pi readsb / tar1090)
            const sdrRes = await fetch(primaryUrl, { signal: AbortSignal.timeout(5000) });
            if (!sdrRes.ok) throw new Error(`Custom Telemetry Source responded with ${sdrRes.status}`);
            const sdrData = await sdrRes.json();

            // Intelligent payload detection
            if (sdrData.aircraft) {
                // readsb / tar1090 array
                rawPlanes = sdrData.aircraft.map(ac => normalize(
                    ac.hex, ac.lat, ac.lon, ac.alt_baro, ac.track,
                    ac.gs, ac.baro_rate, ac.squawk, ac.flight, ac.alt_baro === 'ground',
                    ac.category, ac.t
                ));
            } else if (sdrData.states) {
                // Raw OpenSky-like structure without fetchOpenSky wrapping
                rawPlanes = sdrData.states.map(s => normalize(
                    s[0], s[6], s[5], s[7] || s[13], s[10], 
                    s[9], s[11], s[14], s[1], s[8],
                    s[17], null
                ));
            } else {
                throw new Error("Unrecognized telemetry payload schema.");
            }
            
            // Client requests bounding box, SDR usually returns full global. Filter locally.
            const latMin = parseFloat(lamin); const latMax = parseFloat(lamax);
            const lonMin = parseFloat(lomin); const lonMax = parseFloat(lomax);
            rawPlanes = rawPlanes.filter(p => 
                p.lat >= latMin && p.lat <= latMax &&
                p.lon >= lonMin && p.lon <= lonMax
            );
            sourceName = 'sdr_local';
        }

        console.log(`📡 [LIVE] Primary Telemetry (${sourceName}) Success: ${rawPlanes.length} planes`);
        return res.json({ source: sourceName, planes: rawPlanes, timestamp: Date.now() });

    } catch (primaryErr) {
        console.warn(`⚠️ [LIVE] Primary Telemetry Failed (${primaryErr.message}). Switching to fallback...`);
        
        try {
            // [Fallback] Dynamic Fallback Telemetry
            const fallbackBase = process.env.FALLBACK_TELEMETRY_URL || 'https://api.adsb.lol';
            const lat = (parseFloat(lamin) + parseFloat(lamax)) / 2;
            const lon = (parseFloat(lomin) + parseFloat(lomax)) / 2;
            const dist = 250; // default 250km radius
            
            const fallbackRes = await fetch(`${fallbackBase}/v2/lat/${lat}/lon/${lon}/dist/${dist}`, {
                headers: { 'User-Agent': 'AEROSTRAT/5.0' },
                signal: AbortSignal.timeout(5000)
            });
            
            if (!fallbackRes.ok) throw new Error(`Fallback status ${fallbackRes.status}`);
            const fallbackData = await fallbackRes.json();
            
            const results = (fallbackData.ac || []).map(ac => normalize(
                ac.hex, ac.lat, ac.lon, ac.alt_baro, ac.track,
                ac.gs, ac.baro_rate, ac.squawk, ac.flight, ac.alt_baro === 'ground',
                ac.category, ac.t
            ));
            
            console.log(`✅ [LIVE] Fallback Success: ${results.length} planes`);
            return res.json({ source: 'fallback', planes: results, timestamp: Date.now() });
        } catch (fallbackErr) {
            console.error(`❌ [LIVE] All telemetry sources failed:`, fallbackErr.message);
            res.status(503).json({ error: 'Live data unavailable from all sources', details: fallbackErr.message });
        }
    }
});

// ==========================================
// [v8.0] Multi-Source Flight Details Fusion
// ==========================================
app.get('/api/flight-details/:hex/:callsign', async (req, res) => {
    const hex = req.params.hex.toLowerCase();
    const callsign = req.params.callsign.toUpperCase().trim();
    const cacheKey = `details_${hex}`;

    // 1. Memory Cache Check
    const cached = flightDetailsCache.get(cacheKey);
    if (cached) {
        console.log(`📦 [BFF] Details Cache Hit: ${hex}`);
        return res.json(cached);
    }

    console.log(`📡 [BFF] Aggregating multi-source data for ${hex} / ${callsign}...`);

    // 2. Convergent Parallel Fetch
    const results = await Promise.allSettled([
        // a. [OpenSky State] Latest telemetry
        fetchOpenSky({ icao24: hex }).catch(() => null),
        
        // b. [Route Supplement] Using AeroDataBox as Route API fallback
        fetch(`https://aerodatabox.p.rapidapi.com/flights/callsign/${callsign}`, {
            headers: { 'X-RapidAPI-Key': process.env.AERODATABOX_API_KEY, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' },
            signal: AbortSignal.timeout(4000)
        }).then(r => r.ok ? r.json() : null).catch(() => null),
        
        // c. [Static Metadata] HexDB
        fetch(`https://hexdb.io/api/v1/aircraft/${hex}`, { signal: AbortSignal.timeout(3000) })
            .then(r => r.ok ? r.json() : null).catch(() => null),
            
        // d. [Photos] Planespotters
        fetch(`https://api.planespotters.net/pub/photos/hex/${hex}`, {
            headers: { 'User-Agent': 'AEROSTRAT/5.0' },
            signal: AbortSignal.timeout(4000)
        }).then(r => r.ok ? r.json() : null).catch(() => null),

        // e. [Internal Cache] Local MongoDB metadata (Phase 7 Correction Priority)
        Aircraft.findOne({ icao24: hex }).lean().catch(() => null)
    ]);

    // 3. Data Normalization (MergedFlightData)
    const [osRes, routeRes, hexRes, photoRes, localRes] = results.map(r => r.status === 'fulfilled' ? r.value : null);

    const osState = osRes?.states?.[0] || {};
    const routeInfo = routeRes?.[0] || {}; 
    const aircraftInfo = hexRes || {};
    const photoData = photoRes?.photos?.[0] || {};
    const localInfo = localRes || {};

    const mergedData = {
        hex,
        callsign,
        status: {
            alt: osState.altitude || 0,
            gs: osState.velocity || 0,
            track: osState.heading || 0,
            lat: osState.lat || 0,
            lon: osState.lng || 0,
            squawk: osState.squawk || '0000',
            timestamp: osState.lastContact || Math.floor(Date.now() / 1000)
        },
        route: {
            origin: {
                iata: routeInfo.departure?.airport?.iata || 'N/A',
                name: routeInfo.departure?.airport?.name || 'Unknown Airport',
                city: routeInfo.departure?.airport?.municipalityName || 'Location Unavailable'
            },
            destination: {
                iata: routeInfo.arrival?.airport?.iata || '---',
                name: routeInfo.arrival?.airport?.name || 'Unknown Airport',
                city: routeInfo.arrival?.airport?.municipalityName || 'Location Unavailable'
            }
        },
        aircraft: {
            // Priority: Local Cache > HexDB
            model: localInfo.model || aircraftInfo.typeName || aircraftInfo.type || 'Unknown Model',
            registration: localInfo.registration || aircraftInfo.registration || 'N/A',
            airline: localInfo.operator || aircraftInfo.operator || 'Unknown Airline',
            typecode: localInfo.typecode || aircraftInfo.icaotype || 'Unknown'
        },
        photo: {
            url: photoData.thumbnail_large?.src || photoData.thumbnail?.src || null,
            thumbnail: photoData.thumbnail?.src || null,
            photographer: photoData.photographer || null,
            link: photoData.link || null
        },
        fusedAt: new Date().toISOString()
    };

    // 4. Persistence & Response
    flightDetailsCache.set(cacheKey, mergedData);
    res.json(mergedData);
});

// ==========================================
// [v2.5.2] 資料缺失日誌系統 (Data Deficiency Logging)
// ==========================================
const MISSING_DATA_FILE = path.join(__dirname, 'missing-data.json');
let missingDataLog = {};

function loadMissingDataLog() {
    try {
        if (fs.existsSync(MISSING_DATA_FILE)) {
            missingDataLog = JSON.parse(fs.readFileSync(MISSING_DATA_FILE, 'utf8'));
        }
    } catch (e) { console.error('❌ [MISSING LOG] Load error:', e.message); }
}

// [OPT] 防抖寫入：5秒內的多次觸發合併為一次磁碟寫入
const _saveMissingDataLogNow = () => {
    fs.writeFile(MISSING_DATA_FILE, JSON.stringify(missingDataLog, null, 2), (e) => {
        if (e) console.error('❌ [MISSING LOG] Save error:', e.message);
    });
};
const saveMissingDataLog = debounce(_saveMissingDataLogNow, 5000);

function logMissingData(icao24, type, callsign = null) {
    const key = icao24.toLowerCase();
    if (!missingDataLog[key]) {
        missingDataLog[key] = { icao24, missing: [], firstSeen: new Date().toISOString() };
    }
    if (callsign) missingDataLog[key].callsign = callsign;
    if (!missingDataLog[key].missing.includes(type)) {
        missingDataLog[key].missing.push(type);
        missingDataLog[key].lastAttempt = new Date().toISOString();
        saveMissingDataLog();
        console.log(`${getTime()} 📝 [MISSING LOG] Recorded ${type} for ${icao24}`);
    }
}

function resolveMissingData(icao24, type) {
    const key = icao24.toLowerCase();
    if (missingDataLog[key]) {
        missingDataLog[key].missing = missingDataLog[key].missing.filter(m => m !== type);
        if (missingDataLog[key].missing.length === 0) {
            delete missingDataLog[key];
            console.log(`✅ [MISSING LOG] Resolved all for ${icao24}`);
        }
        saveMissingDataLog();
    }
}

loadMissingDataLog();

app.get('/api/admin/missing-data', (req, res) => {
    res.json(Object.values(missingDataLog));
});

// ==========================================
// 快取系統
// ==========================================
const cache = new Map();
const activeSessions = new Map(); // [Flight Sessions] icao24 -> { sessionId, callsign, lastSeen, onGround }

// [v8.0] BFF Aggregator Caches
const flightDetailsCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 }); // 30 min TTL [Phase 9]
const liveDataFallbackCache = new NodeCache({ stdTTL: 10, checkperiod: 5 }); // 10s TTL for live fallback

// ==========================================
// [SESSION HYDRATION] 伺服器重啟時的智慧記憶恢復
// ==========================================
async function restoreActiveSessions() {
    try {
        const activeSessionsInDb = await FlightSession.find({ status: 'ACTIVE' }).lean();
        let restoredCount = 0;
        let closedCount = 0;
        const now = Date.now();
        const STALE_THRESHOLD = 60 * 60 * 1000; // 嚴格定義：1 小時內沒更新的航班，視為已結束

        for (const session of activeSessionsInDb) {
            // 找出這個航班在資料庫裡「最後一筆」軌跡點
            const lastPoint = await TrackPoint.findOne({ sessionId: session.sessionId })
                .sort({ timestamp: -1 })
                .lean();

            // 如果有軌跡，且最後一次更新是在 1 小時以內，代表它「現在」還在飛
            if (lastPoint && (now - lastPoint.timestamp.getTime() < STALE_THRESHOLD)) {
                activeSessions.set(session.icao24, {
                    sessionId: session.sessionId,
                    callsign: session.callsign || 'N/A',
                    lastSeen: lastPoint.timestamp.getTime(), // 精準使用真實的最後看見時間
                    onGround: !!lastPoint.onGround
                });
                restoredCount++;
            } else {
                // 幽靈航班：伺服器關機太久，這趟飛行早就結束了。強制標記為 COMPLETED。
                const endTime = lastPoint ? lastPoint.timestamp : new Date();
                await FlightSession.updateOne(
                    { sessionId: session.sessionId },
                    { status: 'COMPLETED', endTime: endTime }
                );
                closedCount++;
            }
        }
        console.log(`\x1b[32m✅ [SESSION] 系統重啟：成功恢復 ${restoredCount} 架現役航班，並強制結案 ${closedCount} 架逾期航班。\x1b[0m`);
    } catch (e) {
        console.error(`❌ [SESSION] 記憶恢復失敗:`, e.message);
    }
}
const CACHE_TTL = 30000; // 30 秒快取 (配合前端 30s 輪詢)

function getCached(key) {
    if (cache.has(key)) {
        const entry = cache.get(key);
        if (Date.now() - entry.timestamp < CACHE_TTL) {
            return entry.data;
        }
        // 不要刪除過期快取，因為這會摧毀發生 Timeout 時的 STALE 備援防護網
        // cache.delete(key);
    }
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });

    // 清理過期快取（最多保留 50 個）
    if (cache.size > 50) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
}

// = [v9.0] Phase 9: Ultimate Data Fusion Utilities =
// ==========================================

/**
 * Fetch NOAA METAR data for an airport
 */
async function fetchMetar(icao) {
    if (!icao || icao.length !== 4) return null;
    try {
        const res = await fetch(`https://tgftp.nws.noaa.gov/data/observations/metar/stations/${icao.toUpperCase()}.TXT`, {
            signal: AbortSignal.timeout(3000)
        });
        if (!res.ok) return null;
        const text = await res.text();
        // Simple extraction of the METAR line
        const lines = text.split('\n');
        return lines.length > 1 ? lines[1].trim() : lines[0].trim();
    } catch (e) {
        return null;
    }
}

/**
 * Enhanced Route Data Fetcher (AeroDataBox wrapper)
 */
async function fetchRouteData(callsign) {
    if (!callsign || callsign === 'N/A') return null;
    try {
        const res = await fetch(`https://aerodatabox.p.rapidapi.com/flights/callsign/${callsign.trim().toUpperCase()}`, {
            headers: { 
                'X-RapidAPI-Key': process.env.AERODATABOX_API_KEY, 
                'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' 
            },
            signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                const f = data[0];
                return {
                    origin_iata: f.departure?.airport?.iata || 'N/A',
                    destination_iata: f.arrival?.airport?.iata || '---',
                    destination_icao: f.arrival?.airport?.icao || null,
                    estimated_arrival_time: f.arrival?.scheduledTimeLocal || f.arrival?.scheduledTimeUtc || null,
                    source: 'aerodatabox'
                };
            }
        }
    } catch (e) {
        console.warn(`[ROUTE] fetchRouteData failed for ${callsign}:`, e.message);
    }
    return null;
}

// ==========================================
// OpenSky API OAuth2 認證 Header
// ==========================================
// ==========================================
// OpenSky API OAuth2 多帳號輪替系統
// ==========================================
const ACCOUNTS = [
    { user: process.env.OPENSKY_USER1 || process.env.OPENSKY_USER, pass: process.env.OPENSKY_PASS1 || process.env.OPENSKY_PASS },
    { user: process.env.OPENSKY_USER2, pass: process.env.OPENSKY_PASS2 },
    { user: process.env.OPENSKY_USER3, pass: process.env.OPENSKY_PASS3 },
    { user: process.env.OPENSKY_USER4, pass: process.env.OPENSKY_PASS4 },
    { user: process.env.OPENSKY_USER5, pass: process.env.OPENSKY_PASS5 }
].filter(acc => acc.user && acc.pass);

let accountStates = ACCOUNTS.map(() => ({
    token: null,
    expiresAt: 0
}));

let currentAccountIndex = 0;

function rotateAccount() {
    if (ACCOUNTS.length <= 1) return false;
    currentAccountIndex = (currentAccountIndex + 1) % ACCOUNTS.length;
    console.log(`🔄 [AUTH] Rotating to account #${currentAccountIndex + 1} (${ACCOUNTS[currentAccountIndex].user})`);
    return true;
}

const SAFE_RESERVE_CAP = 50; // 每個帳號保留至少 50 次額度 (User Specified)
const QUOTA_CACHE_FILE = path.join(__dirname, 'quota-cache.json');

function saveQuotaCache() {
    const payload = {
        date: new Date().toISOString().split('T')[0], // YYYY-MM-DD (UTC)
        accounts: apiStats.accounts
    };
    fs.promises.writeFile(QUOTA_CACHE_FILE, JSON.stringify(payload, null, 2))
        .catch(e => console.error('❌ [QUOTA] Failed to save quota cache:', e.message));
}

function loadQuotaCache() {
    try {
        if (fs.existsSync(QUOTA_CACHE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(QUOTA_CACHE_FILE, 'utf8'));
            const savedAccounts = Array.isArray(saved) ? saved : (saved.accounts || []);
            const savedDate = Array.isArray(saved) ? null : saved.date;
            const currentDate = new Date().toISOString().split('T')[0];

            // 如果是舊格式或同一天，則載入
            if (savedDate === currentDate || !savedDate) {
                apiStats.accounts.forEach(acc => {
                    const found = savedAccounts.find(s => s.user === acc.user);
                    if (found) {
                        acc.remainingCredits = found.remainingCredits;
                        acc.unlockTime = found.unlockTime;
                        acc.rateLimits = found.rateLimits || 0;
                    }
                });
                console.log(`💾 [QUOTA] Loaded persistent stats for ${apiStats.accounts.length} accounts.`);
                return savedDate === currentDate; // 回傳是否為當天
            } else {
                console.log(`📅 [QUOTA] Cache is from ${savedDate}, current is ${currentDate}. Forcing reset.`);
            }
        }
    } catch (e) {
        console.error('❌ [QUOTA] Failed to load quota cache:', e.message);
    }
    return false;
}

/**
 * 同步並儲存 Quota 資訊
 */
function syncAccountQuota(index, response) {
    if (!response || !response.headers) return;

    const remainingStr = response.headers.get('x-rate-limit-remaining');
    const retryStr = response.headers.get('x-rate-limit-retry-after-seconds');
    let changed = false;

    if (remainingStr) {
        const remainingNum = parseInt(remainingStr, 10);
        if (apiStats.accounts[index].remainingCredits !== remainingNum) {
            apiStats.accounts[index].remainingCredits = remainingNum;
            changed = true;
        }
        apiStats.accounts[index].unlockTime = null;
    }

    if (response.status === 429 && retryStr) {
        const unlock = new Date(Date.now() + parseInt(retryStr, 10) * 1000).toISOString();
        apiStats.accounts[index].unlockTime = unlock;
        apiStats.accounts[index].rateLimits++;
        changed = true;
    }

    if (changed) {
        saveQuotaCache();
    }
}

async function getAuthHeaders(retryCount = 0) {
    if (ACCOUNTS.length === 0) return {};
    // 防鎖死：如果轉一圈都沒健康的帳號，就硬著頭皮用目前這個 (或交由 429 處理)
    if (retryCount >= ACCOUNTS.length) return { 'Authorization': `Bearer ${accountStates[currentAccountIndex].token}` };

    // 檢查目前帳號是否還有足夠的安全餘額
    const currentStats = apiStats.accounts[currentAccountIndex];
    if (currentStats.remainingCredits !== null && currentStats.remainingCredits <= SAFE_RESERVE_CAP) {
        // 如果目前帳號正在冷卻中就不特別處理（交由後續 429 機制），
        // 否則如果還在 ACTIVE 但餘額不足，嘗試主動輪替
        const isCurrentlyLimited = currentStats.unlockTime && new Date(currentStats.unlockTime).getTime() > Date.now();
        if (!isCurrentlyLimited) {
            logger.warn('QUOTA', `Account ${ACCOUNTS[currentAccountIndex].user} hit safe floor (${currentStats.remainingCredits} remaining ≤ ${SAFE_RESERVE_CAP}) — rotating preemptively`);
            if (rotateAccount()) {
                return await getAuthHeaders(retryCount + 1);
            }
        }
    }

    const account = ACCOUNTS[currentAccountIndex];
    const state = accountStates[currentAccountIndex];

    // 如果 Token 還有效（保留 60 秒緩衝），直接回傳
    if (state.token && Date.now() < state.expiresAt) {
        return { 'Authorization': `Bearer ${state.token}` };
    }

    try {
        console.log(`🔑 [AUTH] Fetching token for account #${currentAccountIndex + 1} (${account.user})...`);
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', account.user);
        params.append('client_secret', account.pass);

        const response = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });

        if (!response.ok) {
            const err = await response.text();
            console.error(`❌ [AUTH ERROR] Failed to get token for ${account.user}: ${err}`);
            // 如果這個帳號認證失敗，嘗試切換下一個
            if (rotateAccount()) return await getAuthHeaders(retryCount + 1);
            return {};
        }

        const data = await response.json();
        state.token = data.access_token;
        state.expiresAt = Date.now() + (data.expires_in - 60) * 1000;

        console.log(`✅ [AUTH] Token received for ${account.user}. Expires in ${data.expires_in}s.`);
        return { 'Authorization': `Bearer ${state.token}` };
    } catch (error) {
        console.error(`❌ [AUTH ERROR] ${error.message}`);
        return {};
    }
}

// ==========================================
// 動作紀錄 API (讓前端的操作顯示在後台終端並寫入 log 檔)
app.post('/api/log', (req, res) => {
    const { message, type = 'info', data = {} } = req.body;
    const hasData = data && Object.keys(data).length > 0;
    const logData = hasData ? data : undefined;
    if (type === 'error')      logger.error('CLIENT', message, logData);
    else if (type === 'warn')  logger.warn('CLIENT', message, logData);
    else                       logger.info('CLIENT', message, logData);
    res.json({ status: 'ok' });
});

// ==========================================
// [v2.9.0] SSE 即時推送系統
// 每次 globalPlanesCache 更新就廣播給所有連接的客戶端
// 客戶端收到事件後立即觸發 fetchPlanes()，延遲從 60s 降至 <1s
// ==========================================
const sseClients = new Set();

app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // 登錄這個客戶端
    sseClients.add(res);
    console.log(`${getTime()} 📡 [SSE] Client connected. Total: ${sseClients.size}`);

    // 立即發送当前資料快照
    res.write(`data: ${JSON.stringify({ type: 'connected', time: globalPlanesCache.time, count: globalPlanesCache.states.length })}\n\n`);

    // 心跳機制：每 30 秒發送一次 ping 防止連線超時斷開
    const heartbeat = setInterval(() => {
        res.write(`: ping\n\n`);
    }, 30000);

    // 客戶端斷開後清理
    req.on('close', () => {
        sseClients.delete(res);
        clearInterval(heartbeat);
        console.log(`📡 [SSE] Client disconnected. Total: ${sseClients.size}`);
    });
});

function broadcastSSE(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(payload); }
        catch (e) { sseClients.delete(client); }
    }
}

// ==========================================
// [v3.0] 飛行異常偵測引擎
// 每次 globalPlanesCache 更新後這行，偵測危險狀態後用 SSE 廣播
// ==========================================
const _prevStates = new Map(); // icao24 -> prev state for diff

// 機場快取
const airportListCache = [];
function detectAnomalies(states) {
    const alerts = [];
    const seenIds = new Set();
    for (const s of states) {
        const icao24 = s[0];
        seenIds.add(icao24);
        const callsign = (s[1] || '').trim();
        const lat = s[6];
        const lng = s[5];
        const altitude = s[7];
        const velocity = s[9];
        const vRate = s[11];
        const onGround = s[8];
        const squawk = s[14];

        if (!lat || !lng) continue;

        const prev = _prevStates.get(icao24);
        _prevStates.set(icao24, { lat, lng, altitude, velocity, onGround, timestamp: Date.now() });

        // Squawk emergency codes
        if (squawk === '7700') alerts.push({ icao24, callsign, lat, lng, type: 'SQUAWK_7700', message: '🚨 MAYDAY — Squawk 7700 General Emergency', severity: 'critical' });
        if (squawk === '7500') alerts.push({ icao24, callsign, lat, lng, type: 'SQUAWK_7500', message: '✈️ HIJACK — Squawk 7500 Unlawful Interference', severity: 'critical' });
        if (squawk === '7600') alerts.push({ icao24, callsign, lat, lng, type: 'SQUAWK_7600', message: '📵 NORDO — Squawk 7600 Radio Failure', severity: 'warning' });

        // Low-altitude high-speed
        if (!onGround && altitude !== null && altitude < 300 && velocity !== null && velocity > 50) {
            alerts.push({ icao24, callsign, lat, lng, type: 'LOW_ALT', message: `⚠️ LOW ALTITUDE: ${Math.round(altitude)}m at ${Math.round(velocity * 3.6)}km/h`, severity: 'warning' });
        }

        // Sudden velocity loss (possible stall/crash)
        if (prev && !onGround && prev.velocity !== null && velocity !== null) {
            const velDrop = prev.velocity - velocity;
            if (velDrop > 80 && prev.onGround === false) {
                alerts.push({ icao24, callsign, lat, lng, type: 'SUDDEN_DECEL', message: `⚠️ RAPID SPEED LOSS: -${Math.round(velDrop * 3.6)}km/h`, severity: 'warning' });
            }
        }
    }

    // Evict planes no longer in feed to prevent unbounded growth
    for (const id of _prevStates.keys()) {
        if (!seenIds.has(id)) _prevStates.delete(id);
    }

    if (alerts.length > 0) {
        broadcastSSE({ type: 'anomalies', alerts });
    }
}

// 健康檢查
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        cacheSize: cache.size,
        activeAccount: ACCOUNTS.length > 0 ? ACCOUNTS[currentAccountIndex].user : 'none',
        totalAccounts: ACCOUNTS.length,
        activeSessions: activeSessions.size,
        ingestion: ingestionStats,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/ingestion/status', async (req, res) => {
    let trackPointCount = null;
    let sessionCount = null;
    try {
        if (mongoose.connection.readyState === 1) {
            trackPointCount = await TrackPoint.estimatedDocumentCount();
            sessionCount = await FlightSession.countDocuments({ status: 'ACTIVE' });
        }
    } catch (_) { }
    res.json({
        ...ingestionStats,
        activeSessions: activeSessions.size,
        trackPointsInDB: trackPointCount,
        activeSessionsInDB: sessionCount,
        globalCachePlanes: globalPlanesCache.states?.length || 0,
        globalCacheStale: globalPlanesCache.stale || false
    });
});

// ==========================================
// API 請求計數器
// ==========================================
var apiStats = {
    totalCalls: 0,
    stateCalls: 0,
    metadataCalls: 0,
    cacheHits: 0,
    accounts: ACCOUNTS.map(acc => ({
        user: acc.user,
        remainingCredits: null,
        unlockTime: null,
        rateLimits: 0
    })),
    errors: 0,
    lastError: null,
    lastErrorTime: null,
    lastSuccessTime: null,
    startTime: Date.now()
};

app.get('/api/stats', function (req, res) {
    res.json({
        totalCalls: apiStats.totalCalls,
        stateCalls: apiStats.stateCalls,
        metadataCalls: apiStats.metadataCalls,
        cacheHits: apiStats.cacheHits,
        accounts: apiStats.accounts,
        errors: apiStats.errors,
        lastError: apiStats.lastError,
        lastErrorTime: apiStats.lastErrorTime,
        lastSuccessTime: apiStats.lastSuccessTime,
        uptimeMinutes: Math.round((Date.now() - apiStats.startTime) / 60000),
        recommendedInterval: calculateRecommendedInterval(),
        activeAccount: ACCOUNTS.length > 0 ? `${currentAccountIndex + 1}/${ACCOUNTS.length} (${ACCOUNTS[currentAccountIndex].user})` : 'none'
    });
});

// ==========================================
// 動態 Quota 延展機制 (Quota Stretching)
// ==========================================
function calculateRecommendedInterval() {
    let minInterval = 15; // 絕對底線 (秒)，避免打太快被強制封鎖

    if (ACCOUNTS.length === 0) return minInterval;

    const currentAcc = apiStats.accounts[currentAccountIndex];

    // 如果目前帳號被鎖定了，或者 quota 資料還沒進來，先給一個保守的預設值 (30秒)
    if (currentAcc.unlockTime && new Date(currentAcc.unlockTime).getTime() > Date.now()) return 30;
    if (currentAcc.remainingCredits === null || currentAcc.remainingCredits === undefined) return minInterval;

    const remaining = currentAcc.remainingCredits;
    // 如果剩餘額度低到危險值 (例如剩不到 30 次)，強制拉長間距到 5 分鐘
    if (remaining <= SAFE_RESERVE_CAP) return 300;

    // 計算距離今日 UTC 00:00 的剩餘秒數
    const now = new Date();
    const tomorrowUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    const secondsUntilReset = Math.floor((tomorrowUTC.getTime() - now.getTime()) / 1000);

    // 留預留額度作為緊急緩衝，剩下的額度平分給剩下的秒數
    const safeCredits = Math.max(1, remaining - SAFE_RESERVE_CAP);
    const calculatedInterval = Math.ceil(secondsUntilReset / safeCredits);

    // 限制在 15秒 到 300秒 之間
    return Math.max(minInterval, Math.min(300, calculatedInterval));
}

// ==========================================
// [V2.0.0] Global Polling System & BBox API
// ==========================================
let globalPlanesCache = { states: [], time: 0 };
let lastGlobalStatesMap = new Map(); // icao24 -> state (用於偵測起飛/降落)
let isFetchingGlobal = false;
let globalRateLimitCooldown = 0; // The timestamp when we are allowed to ping OpenSky again
let lastGlobalFetchTime = 0;

// ==========================================
// [v2.8.4] Spatial Grid Index (空間格狀索引)
// 將全球機場分割到 1°×1° 格子，查詢時只掃描周圍 9 格
// 複雜度：建立 O(n)，查詢 O(k) k≈5~15 >> 比全量掃描快 ~1000 倍
// ==========================================
const GRID_SIZE = 1; // 每格 1 度
let airportSpatialGrid = new Map(); // key: 'lat_lng' -> [airport, ...]

function buildAirportGrid() {
    airportSpatialGrid.clear();
    let count = 0;
    for (const ap of Object.values(globalAirportsDB)) {
        if (!ap.icao || ap.lat === undefined || ap.lng === undefined) continue;
        const cellLat = Math.floor(ap.lat / GRID_SIZE);
        const cellLng = Math.floor(ap.lng / GRID_SIZE);
        const key = `${cellLat}_${cellLng}`;
        if (!airportSpatialGrid.has(key)) airportSpatialGrid.set(key, []);
        airportSpatialGrid.get(key).push(ap);
        count++;
    }
    console.log(`🗺️ [GRID] Spatial index built: ${count} airports in ${airportSpatialGrid.size} cells.`);
}

/**
 * [v2.8.4] 使用空間格狀索引尋找最近的機場 (O(k) 取代 O(n))
 */
function findNearestAirport(lat, lng, maxDist = 15) {
    let nearestAp = null;
    let minDist = maxDist;

    // 計算目標在哪個格子，並掃描周圍 3×3=9 格
    const cellLat = Math.floor(lat / GRID_SIZE);
    const cellLng = Math.floor(lng / GRID_SIZE);

    for (let dlat = -1; dlat <= 1; dlat++) {
        for (let dlng = -1; dlng <= 1; dlng++) {
            const key = `${cellLat + dlat}_${cellLng + dlng}`;
            const candidates = airportSpatialGrid.get(key);
            if (!candidates) continue;
            for (const ap of candidates) {
                const dist = getDistance(lat, lng, ap.lat, ap.lng);
                if (dist < minDist) {
                    minDist = dist;
                    nearestAp = ap;
                }
            }
        }
    }
    return nearestAp;
}

/**
 * 核心：向 OpenSky 發起請求的新型通用函數
 */
async function fetchOpenSky(params = {}) {
    const headers = await getAuthHeaders();
    let url = 'https://opensky-network.org/api/states/all';

    // 構建 BBox 語法
    if (params.lamin !== undefined) {
        url += `?lamin=${params.lamin}&lomin=${params.lomin}&lamax=${params.lamax}&lomax=${params.lomax}`;
    }

    const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30000)
    });

    syncAccountQuota(currentAccountIndex, response);
    apiStats.totalCalls++; // [v4.3.5] Increment total API hits

    if (!response.ok) {
        if (response.status === 429) rotateAccount();
        throw new Error(`OpenSky API Error: ${response.status}`);
    }

    const rawJsonText = await response.text();
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'workers', 'parser.js'));
        worker.postMessage(rawJsonText);
        worker.on('message', (msg) => {
            worker.terminate();
            if (msg.success) resolve({ states: msg.planes, time: msg.time });
            else reject(new Error(msg.error));
        });
        worker.on('error', (err) => {
            worker.terminate();
            reject(err);
        });
    });
}

/**
 * [v10.1] New Primary Telemetry: Airplanes.Live (Multi-Endpoint Support)
 * Supports 'mil', 'point', and 'all' types. Capped at 1 QPS.
 */
async function fetchAirplanesLive(type = 'all', params = {}) {
    let url = `https://api.airplanes.live/v2/${type}`;
    if (type === 'point' && params.lat && params.lon) {
        url = `https://api.airplanes.live/v2/point/${params.lat}/${params.lon}/${params.dist || 250}`;
    }

    const response = await fetch(url, {
        headers: { 'User-Agent': 'AEROSTRAT/10.1 (Hybrid Sync Engine)' },
        signal: AbortSignal.timeout(10000)
    });

    apiStats.totalCalls++;

    if (!response.ok) {
        throw new Error(`Airplanes.Live ${type} Error: ${response.status}`);
    }

    const data = await response.json();
    
    const standardStates = (data.aircraft || []).map(p => ({
        icao24: p.hex?.toLowerCase(),
        callsign: (p.flight || '').trim(),
        lng: p.lon,
        lat: p.lat,
        altitude: p.alt_baro === 'ground' ? 0 : (p.alt_baro || p.alt_geom || 0),
        velocity: (p.gs || 0) * 0.51444,
        heading: p.track || 0,
        vRate: (p.baro_rate || 0) * 0.00508,
        onGround: p.alt_baro === 'ground' || false,
        squawk: p.squawk || null,
        typecode: p.t || p.type || null,
        category: p.category || null,
        isMil: !!(p.mil || p.dbFlags === 1) // Store military flag
    })).filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');

    return { states: standardStates, time: Math.floor(data.now || Date.now() / 1000) };
}

/**
 * [Time Series] Helper to ingest raw plane data into MongoDB
 * Standardizes format, lowercases ICAO24, and filters out corrupted coordinates.
 */
// [v6.0] Ingestion telemetry counters
const ingestionStats = { totalPoints: 0, totalBatches: 0, sessionsCreated: 0, sessionsClosed: 0, lastBatchSize: 0, lastBatchMs: 0 };

async function ingestTrackPoints(states, timeUnix) {
    if (!states || states.length === 0) return;

    if (mongoose.connection.readyState !== 1) {
        console.warn('[DATABASE] Skip ingestion: MongoDB not connected.');
        return;
    }

    const timestamp = new Date(timeUnix * 1000);
    const now = Date.now();
    const batchTrackPoints = [];
    const sessionCloseOps = [];   // Batched session close operations
    const sessionCreateDocs = []; // Batched new session documents

    // ── Session thresholds (defined once outside the hot loop) ─────────
    const SESSION_TIMEOUT_MS = 1200000;     // 20 minutes
    const GROUND_IDLE_TIMEOUT_MS = 900000;  // 15 minutes
    const GROUND_IDLE_SPEED_KTS = 10;       // knots threshold

    for (const p of states) {
        if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;

        const icao24 = p.icao24.toLowerCase();
        const callsign = (p.callsign || 'N/A').toUpperCase().trim();
        const onGround = !!p.onGround;
        const velocityKts = (p.velocity || 0) * 1.94384; // m/s → knots

        // ── SESSION STATE MACHINE (v7.0 Commercial-Grade) ────────────────
        // Transitions:
        //   1. No prior session           → CREATE
        //   2. Callsign changed (non-N/A) → CLOSE old + CREATE
        //   3. Airborne → Ground          → Update state (same session, plane landed)
        //   4. Ground → Airborne          → CLOSE old + CREATE (new flight leg)
        //   5. Inactive > 20 minutes      → CLOSE old + CREATE (timeout)
        //   6. On ground + callsign swap  → CLOSE old + CREATE (turnaround)
        //   7. Ground idle > 15 min (speed < 10 kts) → CLOSE session (parked)

        let session = activeSessions.get(icao24);
        let needsNewSession = false;
        let closeReason = null;

        if (!session) {
            // Case 1: First sighting
            needsNewSession = true;
        } else if (now - session.lastSeen > SESSION_TIMEOUT_MS) {
            // Case 5: Timeout
            needsNewSession = true;
            closeReason = 'TIMEOUT';
        } else if (onGround && velocityKts < GROUND_IDLE_SPEED_KTS) {
            // Case 7: Ground idle tracking (Parked)
            if (!session.groundIdleSince) {
                session.groundIdleSince = now;
            } else if (now - session.groundIdleSince > GROUND_IDLE_TIMEOUT_MS) {
                closeReason = 'COMPLETED';
                needsNewSession = false; 
                sessionCloseOps.push({
                    updateOne: {
                        filter: { sessionId: session.sessionId },
                        update: { $set: { status: 'COMPLETED', endTime: new Date() } }
                    }
                });
                ingestionStats.sessionsClosed++;
                activeSessions.delete(icao24);
                session = null;
            }
            if (session) {
                session.lastSeen = now;
                session.onGround = true;
            }
        } else if (session.onGround && !onGround) {
            // Case 4: Takeoff? — [v11.0 Protection] Require 3 consecutive airborne points
            session.airborneCounter = (session.airborneCounter || 0) + 1;
            session.groundCounter = 0;
            if (session.airborneCounter >= 3) {
                needsNewSession = true;
            }
        } else if (session.callsign !== callsign && callsign !== 'N/A') {
            // Case 2 & 6: Callsign changed
            needsNewSession = true;
        } else if (!session.onGround && onGround) {
            // Case 3: Landing? — [v11.0 Protection] Require 3 points onGround AND alt < 1000
            const altitude = p.altitude || 0;
            if (altitude < 1000) {
                session.groundCounter = (session.groundCounter || 0) + 1;
                session.airborneCounter = 0;
                if (session.groundCounter >= 3) {
                    session.onGround = true;
                    session.groundIdleSince = now;
                }
            } else {
                session.groundCounter = 0;
            }
            session.lastSeen = now;
        } else {
            // Normal movement — reset counters if staying in same state
            if (onGround) {
                session.groundCounter = (session.groundCounter || 0) + 1;
                session.airborneCounter = 0;
            } else {
                session.airborneCounter = (session.airborneCounter || 0) + 1;
                session.groundCounter = 0;
            }
            if (session.groundIdleSince) session.groundIdleSince = null;
        }

        if (needsNewSession) {
            // Close old session (batched)
            if (session) {
                sessionCloseOps.push({
                    updateOne: {
                        filter: { sessionId: session.sessionId },
                        update: { $set: { status: closeReason || 'COMPLETED', endTime: new Date() } }
                    }
                });
                ingestionStats.sessionsClosed++;
            }

            // Create new session
            const newSessionId = `${icao24}_${now}_${Math.random().toString(36).slice(2, 6)}`;
            session = { sessionId: newSessionId, callsign, lastSeen: now, onGround, groundIdleSince: null, groundCounter: 0, airborneCounter: 0 };
            activeSessions.set(icao24, session);

            sessionCreateDocs.push({
                sessionId: newSessionId,
                icao24,
                callsign: callsign !== 'N/A' ? callsign : null,
                startTime: timestamp,
                status: 'ACTIVE'
            });
            ingestionStats.sessionsCreated++;
        } else if (session) {
            // Regular update — refresh heartbeat
            session.lastSeen = now;
            session.onGround = onGround;

            // Resolve unknown callsign if now available
            if (session.callsign === 'N/A' && callsign !== 'N/A') {
                session.callsign = callsign;
                sessionCloseOps.push({
                    updateOne: {
                        filter: { sessionId: session.sessionId },
                        update: { $set: { callsign } }
                    }
                });
            }
        }

        // Skip track point if session was closed by ground-idle (no active session)
        if (!session) continue;

        // Build track point with ALL available telemetry fields
        batchTrackPoints.push({
            sessionId: session.sessionId,
            icao24,
            timestamp,
            lat: p.lat,
            lng: p.lng,
            altitude: (typeof p.altitude === 'number') ? p.altitude : 0,
            geo_altitude: (typeof p.geoAltitude === 'number') ? p.geoAltitude : null,
            velocity: p.velocity || 0,
            heading: p.heading || 0,
            vertical_rate: (typeof p.vRate === 'number') ? p.vRate : null,
            onGround,
            squawk: p.squawk || null
        });
    }

    if (batchTrackPoints.length === 0) return;

    const batchStart = performance.now();

    // Fire all DB writes concurrently — non-blocking pipeline
    const writePromises = [];

    // 1. Bulk insert track points (main payload)
    writePromises.push(
        TrackPoint.insertMany(batchTrackPoints, { ordered: false })
            .catch(err => {
                if (err.name !== 'MongoBulkWriteError' && err.name !== 'MongoServerError') {
                    console.error('[INGEST] TrackPoint write error:', err.message);
                }
            })
    );

    // 2. Bulk session state transitions
    if (sessionCloseOps.length > 0) {
        writePromises.push(
            FlightSession.bulkWrite(sessionCloseOps, { ordered: false })
                .catch(err => console.error('[INGEST] Session update error:', err.message))
        );
    }

    // 3. Bulk session creation
    if (sessionCreateDocs.length > 0) {
        writePromises.push(
            FlightSession.insertMany(sessionCreateDocs, { ordered: false })
                .catch(err => console.error('[INGEST] Session create error:', err.message))
        );
    }

    await Promise.all(writePromises);

    // Update telemetry
    ingestionStats.totalPoints += batchTrackPoints.length;
    ingestionStats.totalBatches++;
    ingestionStats.lastBatchSize = batchTrackPoints.length;
    ingestionStats.lastBatchMs = Math.round(performance.now() - batchStart);
}

// 改寫原本的 fetchGlobalPlanes 為 fetchOpenSky 的封裝
// [v10.2] Dual-Cycle Hybrid Engine State
let syncCycleCount = 0;
let lastOpenSkyFetchTime = 0;

/**
 * [v10.2] Ultimate Hybrid Engine: Global (OpenSky) + Tactical (Airplanes.Live)
 * Cycle: 10s (Tactical) / 30s (Global Baseline)
 */
async function fetchGlobalPlanes() {
    if (isFetchingGlobal) return;
    isFetchingGlobal = true;
    const start = performance.now();
    syncCycleCount++;
    const isOpenSkyCycle = syncCycleCount % 3 === 0 || lastOpenSkyFetchTime === 0;
    logger.debug('SYNC', `Cycle #${syncCycleCount} started | source: ${isOpenSkyCycle ? 'OpenSky (full fetch)' : 'Cache (tactical only)'} | cached: ${(globalPlanesCache.states || []).length} planes`);

    try {
        let mergedStates = [];
        let sourceTags = [];
        const now = Date.now();

        // ── Phase A: GLOBAL BASELINE (Every 3rd cycle = 30s) ───────────
        if (isOpenSkyCycle) {
            try {
                const osData = await fetchOpenSky();
                mergedStates = osData.states;
                lastOpenSkyFetchTime = now;
                sourceTags.push('OpenSky');
                logger.info('SYNC', `OpenSky fetch OK — ${mergedStates.length} planes | ${Math.round(performance.now() - start)}ms`);
            } catch (osErr) {
                logger.warn('SYNC', `OpenSky failed (${osErr.message}) — keeping stale baseline (${(globalPlanesCache.states || []).length} planes)`);
                mergedStates = globalPlanesCache.states || [];
            }
        } else {
            mergedStates = [...(globalPlanesCache.states || [])];
            sourceTags.push('Cache');
        }

        // ── Phase B: TACTICAL OVERLAY (Every cycle = 10s) ───────────────
        const stateMap = new Map(mergedStates.map(p => [p.icao24, p]));

        // 1. Airplanes.Live Military Feed
        try {
            const milData = await fetchAirplanesLive('mil');
            milData.states.forEach(p => stateMap.set(p.icao24, p));
            sourceTags.push('AL-Mil');
        } catch (milErr) {
            logger.warn('SYNC', `AL-Mil failed: ${milErr.message}`);
        }

        // 2. Airplanes.Live Viewport Sensing
        const viewports = getActiveViewports();
        if (viewports.length > 0) {
            logger.debug('SYNC', `Viewport overlay: ${viewports.length} active client(s)`);
            const uniqPorts = viewports.slice(0, 2);
            for (const vp of uniqPorts) {
                const centerLat = (vp.lamin + vp.lamax) / 2;
                const centerLon = (vp.lomin + vp.lomax) / 2;
                try {
                    const regional = await fetchAirplanesLive('point', { lat: centerLat, lon: centerLon, dist: 250 });
                    regional.states.forEach(p => stateMap.set(p.icao24, p));
                    sourceTags.push(`AL-Point(${centerLat.toFixed(1)})`);
                    logger.debug('SYNC', `AL-Point OK lat=${centerLat.toFixed(2)} lon=${centerLon.toFixed(2)} → ${regional.states.length} planes`);
                    await new Promise(r => setTimeout(r, 1100));
                } catch (regErr) {
                    logger.warn('SYNC', `AL-Point failed: ${regErr.message}`);
                }
            }
        } else {
            try {
                const regional = await fetchAirplanesLive('point', { lat: 25.07, lon: 121.23, dist: 250 });
                regional.states.forEach(p => stateMap.set(p.icao24, p));
                sourceTags.push('AL-Home');
                logger.debug('SYNC', `AL-Home (no active viewport) → ${regional.states.length} planes`);
            } catch (hErr) {
                logger.warn('SYNC', `AL-Home fallback failed: ${hErr.message}`);
            }
        }

        const finalStates = Array.from(stateMap.values());
        const fetchLatency = Math.round(performance.now() - start);
        logger.debug('SYNC', `Merge complete — ${finalStates.length} total planes | fetch: ${fetchLatency}ms`);

        // ── Phase C: Metadata Enrichment ──────────────────────────────
        let enrichedCount = 0;
        try {
            const icaoList = finalStates.map(p => p.icao24);
            const metadata = await Aircraft.find({ icao24: { $in: icaoList } }, { icao24: 1, typecode: 1 }).lean();
            const metaMap = new Map(metadata.map(m => [m.icao24.toLowerCase(), m.typecode]));

            finalStates.forEach(p => {
                const lowerIcao = p.icao24.toLowerCase();
                let tc = metaMap.get(lowerIcao);

                // [v11.0] Instant Index Fallback
                if (!tc && aircraftMetadataIndex.has(lowerIcao)) {
                    tc = aircraftMetadataIndex.get(lowerIcao);
                    // Also trigger background DB persistence for this new aircraft if it's missing
                    // We don't await this to keep the broadcast loop fast
                    if (p.callsign && p.callsign !== 'UNKNOWN') {
                        triggerBackgroundResolution(lowerIcao, p.callsign);
                    }
                }

                if (tc) {
                    p.typecode = tc;
                    enrichedCount++;
                }
            });
        } catch (dbErr) {
            logger.warn('METADATA', `Enrichment failed: ${dbErr.message}`);
        }

        const totalLatency = Math.round(performance.now() - start);
        globalPlanesCache = { states: finalStates, time: Math.floor(now/1000), stale: false };

        broadcastPlanes(finalStates, globalPlanesCache.time);

        const sourceStr = sourceTags.join('+');
        logger.info('SYNC', `✅ Cycle #${syncCycleCount} complete | source: ${sourceStr} | planes: ${finalStates.length} | enriched: ${enrichedCount}/${finalStates.length} | latency: ${totalLatency}ms`);

        // [v10.5] Broadcast precise global telemetry with version and source blend
        broadcastTelemetry(apiStats, 10, `${AEROSTRAT_VERSION}: ${sourceStr}`);

    } catch (e) {
        logger.error('SYNC', `Cycle #${syncCycleCount} failed: ${e.message}`);
        globalPlanesCache.stale = true;
    } finally {
        isFetchingGlobal = false;
    }

    // [Audit Fix] Use centralized ingestion helper
    await ingestTrackPoints(globalPlanesCache.states, globalPlanesCache.time);

    // Periodic ingestion health log (every 10th batch = ~5 min at 30s OpenSky interval)
    if (ingestionStats.totalBatches % 10 === 0 && ingestionStats.totalBatches > 0) {
        logger.info('INGEST', `Cumulative: ${ingestionStats.totalPoints.toLocaleString()} pts | ${ingestionStats.totalBatches} batches | last batch: ${ingestionStats.lastBatchSize} pts in ${ingestionStats.lastBatchMs}ms | sessions: ${activeSessions.size} active / ${ingestionStats.sessionsCreated} created / ${ingestionStats.sessionsClosed} closed`);
    }
}

// 啟動 10 秒全球資料輪詢機制 (v10.0 Accelerated Sync)
setInterval(fetchGlobalPlanes, 10000);

// [v7.0] Session timeout reaper — close stale sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    const staleThreshold = 1200000; // 20 minutes (matches SESSION_TIMEOUT_MS)
    const staleIds = [];

    for (const [icao24, session] of activeSessions) {
        if (now - session.lastSeen > staleThreshold) {
            staleIds.push({ icao24, sessionId: session.sessionId });
        }
    }

    if (staleIds.length > 0) {
        for (const { icao24 } of staleIds) activeSessions.delete(icao24);

        const closeOps = staleIds.map(s => ({
            updateOne: {
                filter: { sessionId: s.sessionId },
                update: { $set: { status: 'TIMEOUT', endTime: new Date() } }
            }
        }));

        FlightSession.bulkWrite(closeOps, { ordered: false })
            .then(() => logger.info('SESSION', `Reaper closed ${staleIds.length} timed-out sessions`))
            .catch(err => logger.error('SESSION', `Reaper bulk write failed: ${err.message}`));
    }
}, 300000); // Every 5 minutes

// 啟動時讀取快取並初始化
const isFreshQuota = loadQuotaCache();
initializeAccountQuotas(isFreshQuota);

/**
 * 啟動預熱：若帳號沒有額度紀錄，或跨日更新，先各戳一次 API 建立狀態
 */
async function initializeAccountQuotas(isFreshQuota) {
    console.log(`${getTime()} 🌐 [QUOTA] Initializing quotas for ${ACCOUNTS.length} accounts...`);
    for (let i = 0; i < ACCOUNTS.length; i++) {
        const acc = apiStats.accounts[i];
        // 如果本地已經有今日的額度紀錄，就不再額外請求
        if (isFreshQuota && acc.remainingCredits !== null) {
            console.log(`✅ [QUOTA] Account ${acc.user} has fresh cached quota: ${acc.remainingCredits}`);
            continue;
        }

        try {
            console.log(`${getTime()} 🌐 [QUOTA] Warming up account #${i + 1} (${acc.user})...`);
            // 切換暫時索引來發送請求
            const savedIndex = currentAccountIndex;
            currentAccountIndex = i;

            try {
                const headers = await getAuthHeaders();
                // 使用一個極小範圍的 BBox 請求，盡量不耗費太多資源
                const response = await fetch('https://opensky-network.org/api/states/all?lamin=23.5&lomin=120.5&lamax=23.6&lomax=120.6', {
                    headers,
                    signal: AbortSignal.timeout(10000)
                });
                syncAccountQuota(i, response);
            } finally {
                currentAccountIndex = savedIndex; // 無論成功或失敗都還原
            }

            // 每組間隔一下避免太密集
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            console.error(`❌ [QUOTA] Warm-up failed for ${acc.user}: ${e.message}`);
        }
    }

    // 預熱完後立刻執行一次真正的全球抓取
    fetchGlobalPlanes();
}

// [Surgical Patch] 極簡化 BBox 路由：整合 MongoDB 飛機情報融合
app.get('/api/planes/bbox', async (req, res) => {
    const { lamin, lomin, lamax, lomax } = req.query;

    if (!lamin || !lomin || !lamax || !lomax) {
        return res.status(400).json({ error: 'Missing bounding box parameters' });
    }

    const minLat = parseFloat(lamin);
    const minLng = parseFloat(lomin);
    const maxLat = parseFloat(lamax);
    const maxLng = parseFloat(lomax);

    // [v4.4.0 Optimization] Ultra-fast minimalist filter
    // Enrichment is now handled in the background (fetchGlobalPlanes)
    const planesInBBox = (globalPlanesCache.states || []).filter(p => {
        return p.lat >= minLat && p.lat <= maxLat &&
            p.lng >= minLng && p.lng <= maxLng;
    });

    res.json({
        time: globalPlanesCache.time,
        globalLastUpdate: globalPlanesCache.time,
        states: planesInBBox,
        source: 'global_cache_prestitched',
        stale: !!globalPlanesCache.stale,
        stats: apiStats // [v4.3.6] Restore API stats for HUD synchronization
    });
});

// ==========================================
// [Phase 12] High-Availability Live Data Pump & DB-First Trace
// ==========================================
app.get('/api/flights/live', async (req, res) => {
    try {
        // 1. 【快取攔截】：收到請求時，先檢查 DB 中 last_updated_at 是否在 5 秒內
        const newestFlight = await ActiveFlight.findOne().sort({ last_updated_at: -1 }).lean();
        if (newestFlight && (Date.now() - newestFlight.last_updated_at.getTime() < 5000)) {
            console.log('⚡ [LIVE PUMP] DB Cache Hit (< 5s). Returning instant data from MongoDB.');
            // 只回傳最近有更新的航班
            const recentFlights = await ActiveFlight.find({
                last_updated_at: { $gte: new Date(Date.now() - 300000) } // 前端可能只需最近活躍的
            }).lean();
            
            const standardized = recentFlights.map(f => ({
                hex: f.hex,
                callsign: f.callsign,
                lat: f.current_state?.lat,
                lon: f.current_state?.lon,
                alt: f.current_state?.alt,
                hdg: f.current_state?.hdg,
                gs: f.current_state?.gs
            }));
            return res.json({ source: 'mongodb_cache', states: standardized });
        }

        // 2. 【主線程 (OpenSky)】
        console.log('🌐 [LIVE PUMP] Fetching from Primary Source (OpenSky)...');
        let standardizedStates = [];
        let sourceUsed = 'opensky';

        try {
            const headers = await getAuthHeaders();
            const osRes = await fetch('https://opensky-network.org/api/states/all?lamin=20&lomin=120&lamax=26&lomax=124', {
                headers,
                signal: AbortSignal.timeout(3000) // 3000ms timeout
            });

            if (!osRes.ok) {
                if (osRes.status === 429) rotateAccount();
                throw new Error(`OpenSky failed with status ${osRes.status}`);
            }
            const data = await osRes.json();
            
            if (data.states) {
                standardizedStates = data.states.map(p => ({
                    hex: p[0],
                    callsign: (p[1] || '').trim(),
                    lon: p[5],
                    lat: p[6],
                    alt: p[7] || p[13] || 0,
                    gs: p[9] || 0,
                    hdg: p[10] || 0
                })).filter(p => p.lat !== null && p.lon !== null && p.lat !== undefined && p.lon !== undefined);
            }

        } catch (error) {
            // 3. 【備援切換 (ADSB.lol)】
            console.warn(`⚠️ [CIRCUIT BREAKER] OpenSky failed (${error.message}). Switching to ADSB.lol...`);
            sourceUsed = 'adsb_lol';
            const fallbackRes = await fetch('https://api.adsb.lol/v2/lat/25.0330/lon/121.5654/dist/250', {
                signal: AbortSignal.timeout(5000)
            });
            if (!fallbackRes.ok) throw new Error(`ADSB.lol failed with status ${fallbackRes.status}`);
            const data = await fallbackRes.json();
            
            if (data.ac) {
                standardizedStates = data.ac.map(p => ({
                    hex: p.hex,
                    callsign: (p.flight || '').trim(),
                    lat: p.lat,
                    lon: p.lon,
                    alt: p.alt_baro || p.alt_geom || 0,
                    gs: p.gs || 0,
                    hdg: p.track || 0,
                    typecode: p.t || p.type || null
                })).filter(p => p.lat !== undefined && p.lon !== undefined && p.lat !== null && p.lon !== null);
            }
        }

        // 4. 【資料正規化與寫入 DB】
        if (standardizedStates.length > 0) {
            const now = new Date();
            const bulkOps = standardizedStates.map(p => ({
                updateOne: {
                    filter: { hex: p.hex },
                    update: {
                        $set: {
                            callsign: p.callsign,
                            current_state: {
                                lat: p.lat,
                                lon: p.lon,
                                alt: p.alt,
                                hdg: p.hdg,
                                gs: p.gs
                            },
                            last_updated_at: now
                        },
                        $push: {
                            trace: {
                                $each: [{ lat: p.lat, lon: p.lon, alt: p.alt, timestamp: now }],
                                $slice: -500 // Limit to 500 points
                            }
                        }
                    },
                    upsert: true
                }
            }));

            // Execute bulkWrite
            await ActiveFlight.bulkWrite(bulkOps, { ordered: false });
            console.log(`💾 [LIVE PUMP] Upserted ${bulkOps.length} flights into MongoDB.`);
        }

        // 5. 回傳最新陣列給前端
        res.json({ source: sourceUsed, states: standardizedStates });

    } catch (err) {
        console.error('❌ [LIVE PUMP ERROR]', err.message);
        res.status(500).json({ error: 'Live data pump failed completely', details: err.message });
    }
});

// 【歷史軌跡補全端點】
app.get('/api/flight-trace/:hex', async (req, res) => {
    const hex = req.params.hex.toLowerCase();
    try {
        // 1. 【DB 優先】
        const dbFlight = await ActiveFlight.findOne({ hex }).lean();
        
        if (dbFlight && dbFlight.trace && dbFlight.trace.length > 20) {
            console.log(`🎯 [TRACE] DB Hit for ${hex} (${dbFlight.trace.length} points). Instant render.`);
            return res.json({ hex, source: 'mongodb', trace: dbFlight.trace });
        }

        // 2. 【API 補全 (ADSB.lol)】
        console.log(`⚡ [TRACE] DB Miss or sparse trace for ${hex}. Backfilling from ADSB.lol...`);
        const fallbackRes = await fetch(`https://api.adsb.lol/v2/trace/${hex}`, {
            signal: AbortSignal.timeout(5000)
        });

        if (!fallbackRes.ok) {
            if (fallbackRes.status === 404) {
               return res.json({ hex, source: 'mongodb_sparse', trace: dbFlight ? dbFlight.trace : [] });
            }
            throw new Error(`ADSB.lol trace failed: ${fallbackRes.status}`);
        }

        const data = await fallbackRes.json();
        
        let backfilledTrace = [];
        if (data.trace && Array.isArray(data.trace)) {
            backfilledTrace = data.trace.map(pt => ({
                timestamp: new Date(pt[0] * 1000),
                lat: pt[1],
                lon: pt[2],
                alt: pt[3],
                hdg: pt[4] || 0,
                gs: pt[5] || 0
            })).filter(pt => pt.lat !== undefined && pt.lon !== undefined && pt.lat !== null && pt.lon !== null);
        }

        // 3. 【回填 DB】
        if (backfilledTrace.length > 0) {
            console.log(`💾 [TRACE] Backfilling ${backfilledTrace.length} points to MongoDB for ${hex}.`);
            await ActiveFlight.findOneAndUpdate(
                { hex },
                {
                    $set: { trace: backfilledTrace.slice(-500) },
                    $setOnInsert: { last_updated_at: new Date() }
                },
                { upsert: true }
            );
        }

        // 4. 回傳完整的軌跡陣列給前端
        res.json({ hex, source: 'adsb_lol', trace: backfilledTrace });

    } catch (err) {
        console.error(`❌ [TRACE ERROR] ${hex}:`, err.message);
        const backup = await ActiveFlight.findOne({ hex }).lean();
        res.json({ hex, source: 'error_fallback', trace: backup && backup.trace ? backup.trace : [], error: err.message });
    }
});

// ==========================================
// [Phase 14] Ultimate Data Fusion Controller
// ==========================================
app.get('/api/flight/complete-details/:hex/:callsign', flightController.getCompleteDetails);

// ==========================================
// 飛機 Metadata（機型/製造商/註冊號）— 永久快取與靜態字典
// ==========================================
const AIRCRAFT_STATIC_FILE = path.join(__dirname, 'data', 'aircraft_static.json');
let aircraftStaticDB = {};

// 啟動時載入靜態字典
try {
    if (fs.existsSync(AIRCRAFT_STATIC_FILE)) {
        aircraftStaticDB = JSON.parse(fs.readFileSync(AIRCRAFT_STATIC_FILE, 'utf8'));
        console.log(`${getTime()} 📂 [METADATA STATIC] Loaded ${Object.keys(aircraftStaticDB).length} aircraft from static DB`);
    }
} catch (e) {
    console.warn('⚠️ Failed to load static metadata:', e.message);
}

// [REMOVED] saveMetadataCache is no longer needed with MongoDB

app.get('/api/metadata/:icao24', async (req, res) => {
    const icao24 = req.params.icao24.toLowerCase();

    // 1. 優先檢查靜態字典 (Static First)
    if (aircraftStaticDB[icao24]) {
        return res.json({ ...aircraftStaticDB[icao24], fromStatic: true });
    }

    // [HOTFIX] 連線狀態守衛
    if (mongoose.connection.readyState !== 1) {
        return res.json({ icao24, noData: true, error: 'Database not connected' });
    }

    try {
        // 2. 檢查 MongoDB 永久快取
        const dbAircraft = await Aircraft.findOne({ icao24 }).lean();
        if (dbAircraft) {
            // Normalize: OSINT stores type_code, OpenSky API stores typecode — unify to typecode
            if (!dbAircraft.typecode && dbAircraft.type_code) {
                dbAircraft.typecode = dbAircraft.type_code;
            }
            if (!dbAircraft.registration && dbAircraft.registered_owner) {
                dbAircraft.registration = dbAircraft.registered_owner;
            }
            if (!dbAircraft.manufacturerName && dbAircraft.manufacturer) {
                dbAircraft.manufacturerName = dbAircraft.manufacturer;
            }
            if (!dbAircraft.owner && dbAircraft.operator) {
                dbAircraft.owner = dbAircraft.operator;
            }
            return res.json(dbAircraft);
        }

        // 3. 抓取外部 API
        const url = `https://opensky-network.org/api/metadata/aircraft/icao/${icao24}`;
        console.log(`🌐 [METADATA] Fetching metadata for ${icao24}...`);
        const headers = await getAuthHeaders();
        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            syncAccountQuota(currentAccountIndex, response);
            // 記錄為「無資料」存入 DB 避免重複查詢
            await Aircraft.findOneAndUpdate(
                { icao24 },
                { icao24, noData: true, lastUpdated: new Date() },
                { upsert: true }
            );
            logMissingData(icao24, 'metadata');
            return res.json({ icao24, noData: true });
        }

        syncAccountQuota(currentAccountIndex, response);

        const data = await response.json();
        const metadata = {
            icao24: icao24,
            registration: data.registration || '',
            manufacturerName: data.manufacturerName || '',
            model: data.model || '',
            typecode: data.typecode || '',
            owner: data.owner || '',
            operatorCallsign: data.operatorCallsign || '',
            built: data.built || '',
            categoryDescription: data.categoryDescription || '',
            lastUpdated: new Date()
        };

        // 存入 MongoDB
        await Aircraft.findOneAndUpdate({ icao24 }, metadata, { upsert: true });
        resolveMissingData(icao24, 'metadata');
        console.log(`${getTime()} 📦 [METADATA] Cached to DB: ${icao24} = ${metadata.typecode} ${metadata.model}`);

        res.json(metadata);
    } catch (error) {
        console.error(`❌ [METADATA ERROR] ${icao24}: ${error.message}`);
        res.json({ icao24, noData: true, error: error.message });
    }
});

// ==========================================
// 批次 Metadata 預取（背景自動擷取所有可見飛機的資料）
// ==========================================
app.post('/api/metadata/batch', async function (req, res) {
    const icao24List = req.body.icao24s || [];

    // [HOTFIX] 連線狀態守衛
    if (mongoose.connection.readyState !== 1) {
        return res.json({ fetched: 0, error: 'Database not connected' });
    }

    // 過濾靜態字典中已有的
    const filteredIcaos = icao24List.filter(id => !aircraftStaticDB[id.toLowerCase()]);
    if (filteredIcaos.length === 0) return res.json({ fetched: 0 });

    try {
        // 從 MongoDB 找出已有的
        const existingInDb = await Aircraft.find({ icao24: { $in: filteredIcaos.map(id => id.toLowerCase()) } }).lean();
        const existingIcaos = new Set(existingInDb.map(a => a.icao24));

        const uncached = filteredIcaos.filter(id => !existingIcaos.has(id.toLowerCase()));

        if (uncached.length === 0) {
            return res.json({ fetched: 0, reason: 'all_cached' });
        }

        // [OPT 5.1] 如果當前帳號 quota 已低於安全線，跳過本次批次
        const currentAcc = apiStats.accounts[currentAccountIndex];
        if (currentAcc.remainingCredits !== null && currentAcc.remainingCredits <= SAFE_RESERVE_CAP) {
            return res.json({ fetched: 0, skipped: uncached.length, reason: 'quota_low' });
        }

        // 最多同時查詢 10 架
        const toFetch = uncached.slice(0, 10);
        let fetched = 0;

        for (let i = 0; i < toFetch.length; i++) {
            const icao24 = toFetch[i].toLowerCase();
            try {
                const headers = await getAuthHeaders();
                apiStats.totalCalls++;
                apiStats.metadataCalls++;
                const response = await fetch(
                    'https://opensky-network.org/api/metadata/aircraft/icao/' + icao24,
                    { headers, signal: AbortSignal.timeout(8000) }
                );

                if (response.status === 429) {
                    syncAccountQuota(currentAccountIndex, response);
                    break;
                }

                syncAccountQuota(currentAccountIndex, response);

                if (response.ok) {
                    const data = await response.json();
                    const metadata = {
                        icao24: icao24,
                        registration: data.registration || '',
                        manufacturerName: data.manufacturerName || '',
                        model: data.model || '',
                        typecode: data.typecode || '',
                        owner: data.owner || '',
                        operatorCallsign: data.operatorCallsign || '',
                        built: data.built || '',
                        categoryDescription: data.categoryDescription || '',
                        lastUpdated: new Date()
                    };
                    await Aircraft.findOneAndUpdate({ icao24 }, metadata, { upsert: true });
                    resolveMissingData(icao24, 'metadata');
                    fetched++;
                } else {
                    await Aircraft.findOneAndUpdate({ icao24 }, { icao24, noData: true, lastUpdated: new Date() }, { upsert: true });
                    logMissingData(icao24, 'metadata');
                }
            } catch (e) {
                apiStats.errors++;
            }

            if (i < toFetch.length - 1) {
                await new Promise(r => setTimeout(r, 300));
            }
        }

        console.log(`${getTime()} 📦 [BATCH] Fetched ${fetched}/${toFetch.length} metadata to MongoDB`);
        res.json({ fetched: fetched, requested: toFetch.length });
    } catch (err) {
        console.error('❌ [BATCH ERROR]', err.message);
        res.status(500).json({ fetched: 0, error: err.message });
    }
});

// ==========================================
// 航班來源/目的地 API (flights/aircraft & routes)
// 實作: 固定航班航線字典 (Flight Route Database)
// ==========================================
// ==========================================
// 航班來源/目的地 API (flights/aircraft & routes)
// 實作: 固定航班航線字典 (Flight Route Database)
// ==========================================
const LOCAL_ROUTES_FILE = path.join(__dirname, 'data', 'local_routes.json');
const SCHEDULES_STATIC_FILE = path.join(__dirname, 'data', 'schedules_static.json');
const GLOBAL_AIRPORTS_FILE = path.join(__dirname, 'data', 'processed', 'airports_global.json');
const GLOBAL_AIRLINES_FILE = path.join(__dirname, 'data', 'processed', 'airlines.json');

let routesDatabase = {};
let localRoutesDB = {};
let schedulesStaticDB = {};
let globalAirportsDB = {};
let globalAirlinesDB = {};

function loadGlobalData() {
    try {
        if (fs.existsSync(GLOBAL_AIRPORTS_FILE)) {
            globalAirportsDB = JSON.parse(fs.readFileSync(GLOBAL_AIRPORTS_FILE, 'utf8'));
            console.log(`🌍 [GLOBAL] Loaded ${Object.keys(globalAirportsDB).length} airports.`);
        }
        if (fs.existsSync(GLOBAL_AIRLINES_FILE)) {
            globalAirlinesDB = JSON.parse(fs.readFileSync(GLOBAL_AIRLINES_FILE, 'utf8'));
            console.log(`✈️ [GLOBAL] Loaded ${Object.keys(globalAirlinesDB).length} airline aliases.`);
        }
    } catch (e) {
        console.error('❌ [GLOBAL DATA ERROR] Failed to load global JSON files:', e.message);
    }
}

// [OPT 1.1] 機場清單快取變數與函式——必須在 loadGlobalData()/buildAirportGrid() 之前宣告
let _cachedAirportList = null;
let _cachedAirportListETag = '';

async function buildAirportListCache() {
    if (mongoose.connection.readyState !== 1) {
        console.warn('⚠️ [GIS] MongoDB not ready, skipping airport cache build.');
        return;
    }
    try {
        // [Surgical Patch] GIS 快取升級：捨棄舊的 JSON，改由 MongoDB 撈取
        const airports = await Airport.find({}, { icao: 1, iata: 1, name: 1, city: 1, country: 1, location: 1 }).lean();

        if (airports.length === 0) {
            console.warn('⚠️ [GIS] MongoDB airports collection is empty! Map markers might be missing.');
        }

        _cachedAirportList = airports.map(a => ({
            icao: a.icao,
            iata: a.iata,
            name: a.name,
            city: a.city,
            country: a.country,
            lat: a.location ? a.location.coordinates[1] : null,
            lng: a.location ? a.location.coordinates[0] : null
        }));

        // 保留 W/ 前綴與生成邏輯
        _cachedAirportListETag = 'W/"' + _cachedAirportList.length + '-' + Date.now() + '"';
        console.log(`✅ [GIS] Airport cache built from MongoDB: ${_cachedAirportList.length} airports.`);
    } catch (e) {
        console.error('❌ [GIS] Failed to build airport cache:', e.message);
    }
}

loadGlobalData();
buildAirportGrid(); // [v2.8.4] 建立空間格狀索引
buildAirportListCache(); // [OPT 1.1] 預計算機場清單快取

// Helper to resolve airline aliases (e.g., APJ -> MM, TTW -> IT)
function resolveAirlineAlias(callsign) {
    if (!callsign) return null;
    const match = callsign.match(/^([A-Z]{2,3})(\d+)$/);
    if (!match) return callsign;

    const code = match[1];
    const num = match[2];
    const alias = globalAirlinesDB[code];

    if (alias && (alias.iata || alias.icao)) {
        const otherCode = alias.iata || alias.icao;
        return { original: callsign, alias: otherCode + num };
    }
    return callsign;
}

try {
    if (fs.existsSync(LOCAL_ROUTES_FILE)) {
        localRoutesDB = JSON.parse(fs.readFileSync(LOCAL_ROUTES_FILE, 'utf8'));
        console.log(`🗺️ [LOCAL ROUTES] Loaded ${Object.keys(localRoutesDB).length} routes from static dictionary`);
    }
    if (fs.existsSync(SCHEDULES_STATIC_FILE)) {
        schedulesStaticDB = JSON.parse(fs.readFileSync(SCHEDULES_STATIC_FILE, 'utf8'));
        console.log(`🗺️ [SCHEDULES STATIC] Loaded ${Object.keys(schedulesStaticDB).length} routes from static DB`);
    }
} catch (e) {
    console.error('❌ [ROUTE DB] Failed to load route JSONs:', e.message);
}

// [REMOVED] routesDatabase is migrated to MongoDB

const routeCache = new Map(); // icao24 -> { data, timestamp } (動態航線快取)
const ROUTE_CACHE_TTL = 1800000; // 30 分鐘

// 快取變數與函式已在上方 loadGlobalData() 前方訝明

app.get('/api/airports/list', async (req, res) => {
    if (!_cachedAirportList) await buildAirportListCache();
    // ETag 瀏覽器快取：若資料未變，回傳 304 Not Modified 節省頻寬
    if (req.headers['if-none-match'] === _cachedAirportListETag) {
        return res.status(304).end();
    }
    res.setHeader('ETag', _cachedAirportListETag);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(_cachedAirportList);
});

app.get('/api/airport/:code', async (req, res) => {
    const code = req.params.code.toUpperCase();

    try {
        // 1. Prioritize MongoDB (GIS Modernization)
        if (mongoose.connection.readyState === 1) {
            const dbAirport = await Airport.findOne({
                $or: [{ icao: code }, { iata: code }]
            }).lean();
            if (dbAirport) {
                return res.json({
                    icao: dbAirport.icao,
                    iata: dbAirport.iata,
                    name: dbAirport.name,
                    city: dbAirport.city,
                    country: dbAirport.country,
                    lat: dbAirport.location ? dbAirport.location.coordinates[1] : null,
                    lng: dbAirport.location ? dbAirport.location.coordinates[0] : null,
                    timezone: dbAirport.timezone,
                    source: 'mongodb'
                });
            }
        }

        // 2. Check Global Database (Fast Key Lookup)
        if (globalAirportsDB[code]) {
            return res.json({ ...globalAirportsDB[code], source: 'global_json_key' });
        }

        // 3. Deep Scan Global Database (Fallback for missing keys)
        // Optimization: only scan if code looks like IATA (3 chars) or ICAO (4 chars)
        if (code.length === 3 || code.length === 4) {
            const deepMatch = Object.values(globalAirportsDB).find(ap => ap.icao === code || ap.iata === code);
            if (deepMatch) {
                return res.json({ ...deepMatch, source: 'global_json_deep' });
            }
        }

        // 4. Check METAR collection (Legacy Fallback)
        if (mongoose.connection.readyState === 1) {
            const metarAirport = await Metar.findOne({ $or: [{ icaoId: code }, { iataId: code }] }).lean();
            if (metarAirport) {
                return res.json({
                    icao: metarAirport.icaoId,
                    iata: metarAirport.iataId,
                    name: metarAirport.name,
                    city: metarAirport.city,
                    country: metarAirport.country,
                    lat: metarAirport.lat,
                    lng: metarAirport.lon,
                    source: 'metar_db'
                });
            }
        }
    } catch (e) {
        console.warn(`⚠️ [AIRPORT API] Resolution error for ${code}:`, e.message);
    }

    return res.status(404).json({ error: 'Airport not found' });
});

// ==========================================
// [v12.5] ADSB.lol Static DB Proxy (CORS-safe)
// Frontend calls /api/adsb-static/:prefix → backend fetches from api.adsb.lol
// ==========================================
app.get('/api/adsb-static/:prefix', async (req, res) => {
    const prefix = req.params.prefix.replace(/[^0-9a-f]/gi, '').toLowerCase().slice(0, 2);
    if (!prefix) return res.status(400).json({ error: 'Invalid prefix' });
    try {
        const upstream = await fetch(`https://api.adsb.lol/v2/static/db/${prefix}.json`, {
            signal: AbortSignal.timeout(5000)
        });
        // Always return 200 to client — upstream failures are silent graceful empties.
        // Forwarding 503/504 would flood browser console with red errors.
        if (!upstream.ok) {
            return res.status(200).json({});
        }
        const data = await upstream.json();
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.json(data);
    } catch (e) {
        // Timeout or network error → empty response, not an error from client's perspective
        res.status(200).json({});
    }
});

// ==========================================
// 飛機輪廓 SVG 資料 (來自 AircraftShape collection)
// ==========================================
app.get('/api/aircraft-shapes', async (req, res) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ error: 'Database not connected' });
    }
    try {
        const shapes = await AircraftShape.find({}, { _id: 0 }).lean();
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h 瀏覽器快取
        res.json(shapes);
    } catch (err) {
        console.error('[SHAPES] Fetch error:', err.message);
        res.status(500).json({ error: 'Failed to fetch aircraft shapes' });
    }
});

// ==========================================
// 飛機照片代理 (Planespotters.net) — 後端統一出口，避免前端直連
// ==========================================
app.get('/api/photos/:icao24', async (req, res) => {
    const { icao24 } = req.params;
    const { reg } = req.query;

    try {
        // [DB CACHE] 1. 優先從 MongoDB 讀取（僅在已連線時）
        if (mongoose.connection.readyState === 1) {
            const aircraft = await Aircraft.findOne({ icao24: icao24.toLowerCase() }).lean();
            if (aircraft?.photoData?.url) {
                console.log(`🖼️ [CACHE HIT] Returning saved photo for ${icao24}`);
                return res.json([{
                    thumbnail: { src: aircraft.photoData.thumbnail },
                    thumbnail_large: { src: aircraft.photoData.url },
                    photographer: aircraft.photoData.photographer,
                    link: aircraft.photoData.link,
                    source: 'mongodb_cache'
                }]);
            }
        }

        // 2. 緩存失效（或 DB 未連線），抓取外部 API
        let photos = [];
        const hexRes = await fetch(`https://api.planespotters.net/pub/photos/hex/${icao24}`, {
            headers: { 'User-Agent': 'AEROSTRAT/5.0 (flight-tracking)' }
        });
        if (hexRes.ok) {
            const data = await hexRes.json();
            if (data.photos?.length) photos = data.photos;
        }

        if (photos.length === 0 && reg && reg !== 'N/A') {
            const regRes = await fetch(`https://api.planespotters.net/pub/photos/reg/${reg}`, {
                headers: { 'User-Agent': 'AEROSTRAT/5.0 (flight-tracking)' }
            });
            if (regRes.ok) {
                const data = await regRes.json();
                if (data.photos?.length) photos = data.photos;
            }
        }

        // [DB CACHE] 3. 若抓到圖片，非同步存入資料庫（僅在已連線時）
        if (photos.length > 0 && mongoose.connection.readyState === 1) {
            const p = photos[0];
            Aircraft.findOneAndUpdate(
                { icao24: icao24.toLowerCase() },
                {
                    $set: {
                        'photoData.url': p.thumbnail_large?.src || p.thumbnail?.src,
                        'photoData.thumbnail': p.thumbnail?.src,
                        'photoData.photographer': p.photographer,
                        'photoData.link': p.link,
                        'photoData.lastUpdated': new Date()
                    }
                },
                { upsert: true }
            ).catch(err => console.error('❌ [PHOTO SAVE ERROR]', err.message));
        }

        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.json(photos);
    } catch (err) {
        console.error('[PHOTOS] Proxy error:', err.message);
        res.status(500).json({ error: 'Photo fetch failed' });
    }
});

// ==========================================
// Airline Info Endpoint
// ==========================================
app.get('/api/airline/:callsign', (req, res) => {
    const callsign = (req.params.callsign || '').toUpperCase().trim();
    if (!callsign) return res.status(400).json({ error: 'Callsign required' });

    // Extract ICAO prefix (first 2-3 letters before digits)
    const match = callsign.match(/^([A-Z]{2,3})/);
    const prefix = match ? match[1] : callsign;

    const airline = globalAirlinesDB[prefix];
    if (airline) {
        const iata = airline.iata || null;
        return res.json({
            name: airline.name || 'Unknown',
            iata: iata,
            icao: airline.icao || prefix,
            logo: iata ? `https://pics.avs.io/200/80/${iata}.png` : null,
        });
    }

    res.json({ name: null, iata: null, icao: prefix, logo: null });
});

// ==========================================
// 飛機詳細資訊 API (整合 OpenSky & AircraftRegistry)
// ==========================================
// ==========================================
// 飛機詳細資訊 API (專業級多源融合：adsb.fi > OpenSky > Internal)
// ==========================================
app.get('/api/aircraft/:icao24', async (req, res) => {
    const icao24 = req.params.icao24.toLowerCase();

    try {
        // [DB CACHE] 1. 優先從 MongoDB 讀取
        let [aircraft, registry] = await Promise.all([
            Aircraft.findOne({ icao24 }).lean(),
            AircraftRegistry.findOne({ icao24 }).lean().catch(() => null)
        ]);

        // [v9.6] Professional Stale Check: Refresh if no typecode (1 day) or if record > 1 day old
        const hasTypecode = !!(aircraft && (aircraft.typecode || aircraft.type_code));
        const isStale = !aircraft || (
            (aircraft.noData && (new Date() - aircraft.lastUpdated > 3600000)) ||
            (!hasTypecode && (new Date() - aircraft.lastUpdated > 43200000)) ||
            (new Date() - aircraft.lastUpdated > 86400000)
        );

        // 如果資料存在且有效（有機型代碼且未過期），直接回傳
        if (aircraft && !aircraft.noData && !isStale && hasTypecode) {
            // Normalize: OSINT stores type_code, unify to typecode for consistent frontend response
            if (!aircraft.typecode && aircraft.type_code) aircraft.typecode = aircraft.type_code;
            return res.json({
                ...aircraft,
                age: registry?.age || null,
                engineType: registry?.engineType || null,
                source: 'mongodb_cache'
            });
        }

        logger.debug('FUSION', `Resolving metadata for ${icao24}`);

        // --- Tier 2: adsb.fi (Fast, Open Data, Good for Typecode/Registration) ---
        let fusionData = null;
        try {
            const fiRes = await fetch(`https://opendata.adsb.fi/api/v2/hex/${icao24}`, { signal: AbortSignal.timeout(3000) });
            if (fiRes.ok) {
                const fiData = await fiRes.json();
                if (fiData.ac && fiData.ac.length > 0) {
                    const ac = fiData.ac[0];
                    logger.debug('FUSION', `adsb.fi resolved ${icao24}: reg=${ac.r} type=${ac.t}`);
                    fusionData = {
                        registration: ac.r || '',
                        typecode: ac.t || '',
                        model: ac.type || '',
                        operatorCallsign: ac.flight || '',
                        source: 'adsb.fi'
                    };
                }
            }
        } catch (e) { logger.debug('FUSION', `adsb.fi failed for ${icao24}: ${e.message}`); }

        // --- Tier 3: OpenSky Network (Detailed, but slow/rate-limited) ---
        if (!fusionData || !fusionData.typecode) {
            try {
                const osRes = await fetch(`https://opensky-network.org/api/metadata/aircraft/icao/${icao24}`, { signal: AbortSignal.timeout(5000) });
                if (osRes.ok) {
                    const osData = await osRes.json();
                    logger.info('FUSION', `OpenSky solved ${icao24}: ${osData.registration} (${osData.typecode})`);
                    fusionData = {
                        registration: osData.registration || fusionData?.registration || '',
                        manufacturerName: osData.manufacturerName || '',
                        model: osData.model || fusionData?.model || '',
                        typecode: osData.typecode || fusionData?.typecode || '',
                        owner: osData.owner || '',
                        operatorCallsign: osData.operatorCallsign || fusionData?.operatorCallsign || '',
                        categoryDescription: osData.categoryDescription || '',
                        source: 'opensky'
                    };
                }
            } catch (e) { logger.warn('FUSION', `OpenSky failed for ${icao24}: ${e.message}`); }
        }

        // --- Finalize & Save ---
        if (fusionData) {
            const metadata = {
                icao24,
                ...fusionData,
                noData: false,
                lastUpdated: new Date()
            };
            const updated = await Aircraft.findOneAndUpdate({ icao24 }, metadata, { upsert: true, returnDocument: 'after' }).lean();
            return res.json({
                ...updated,
                age: registry?.age || null,
                source: `live_fusion_${fusionData.source}`
            });
        }

        // Both failed, mark as noData but keep registry info if available
        await Aircraft.findOneAndUpdate({ icao24 }, { icao24, noData: true, lastUpdated: new Date() }, { upsert: true });
        return res.json({ 
            icao24, 
            registration: registry?.registration || aircraft?.registration || null, 
            model: aircraft?.model || null,
            noData: true,
            source: 'none'
        });

    } catch (err) {
        console.error(`❌ [FUSION ERROR] ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Haversine Formula — 計算兩點經緯度距離 (km)
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

app.get('/api/route/:icao24', async (req, res) => {
    const icao24 = req.params.icao24.toLowerCase();
    const queryCallsign = (req.query.callsign || '').toUpperCase();
    const cleanCallsign = queryCallsign.replace(/[^A-Z0-9]/g, '');

    // 1. Try static schedules and local routes first (Higher Priority)
    let searchCallsigns = [cleanCallsign];
    const resolved = resolveAirlineAlias(cleanCallsign);
    if (resolved && resolved.alias) {
        searchCallsigns.push(resolved.alias);
    }

    let route = null;
    let matchSource = '';

    // [HOTFIX] 連線狀態守衛
    if (mongoose.connection.readyState !== 1) {
        return res.json({ icao24, noData: true, error: 'Database not connected' });
    }

    for (const cs of searchCallsigns) {
        if (!cs) continue;
        if (schedulesStaticDB[cs]) {
            route = { dep: schedulesStaticDB[cs].dep, arr: schedulesStaticDB[cs].arr };
            matchSource = 'static_db';
            break;
        }
        if (localRoutesDB[cs]) {
            route = { dep: localRoutesDB[cs][0], arr: localRoutesDB[cs][1] };
            matchSource = 'local_dict';
            break;
        }

        // 從 MongoDB 檢查快取
        const dbRoute = await Route.findOne({ callsign: cs }).lean();
        if (dbRoute) {
            route = { dep: dbRoute.departureAirport, arr: dbRoute.arrivalAirport };
            matchSource = 'mongodb_cache';
            break;
        }
    }

    if (route) {
        if (route.dep && route.dep.length === 3) route.dep = globalAirportsDB[route.dep]?.icao || route.dep;
        if (route.arr && route.arr.length === 3) route.arr = globalAirportsDB[route.arr]?.icao || route.arr;

        return res.json({
            icao24,
            callsign: cleanCallsign,
            departureAirport: route.dep,
            arrivalAirport: route.arr,
            fromStaticDB: true,
            source: matchSource
        });
    }

    // 2. 檢查記憶體動態快取
    const cached = routeCache.get(icao24);
    if (cached && (Date.now() - cached.timestamp < ROUTE_CACHE_TTL)) {
        return res.json(cached.data);
    }

    try {
        // --- Layer 3: Spatial Reverse-Geocoding (物理足跡推測) ---
        console.log(`🔍 [SPATIAL] Attempting inference for ${cleanCallsign} (${icao24})...`);

        // [OPT 1.3] 直接呼叫內部函式取得 track，不再透過 localhost HTTP 請求
        const trackData = await fetchTracksInternal(icao24);

        if (trackData && trackData.path && trackData.path.length > 0) {
            resolveMissingData(icao24, 'route'); // [v2.5.2]
            const startPoint = trackData.path[0];
            const startLat = startPoint[1];
            const startLng = startPoint[2];

            // [OPT 1.2] 使用空間索引 O(k) 取代 O(n) 全量搜尋 (~1000x 加速)
            // [v4.4.0] 擴大半徑至 20km，覆蓋更大範圍的離場活動
            const nearestAp = findNearestAirport(startLat, startLng, 20);

            if (nearestAp) {
                console.log(`✅ [SPATIAL] Inferred Departure: ${nearestAp.icao} (${nearestAp.name}) for ${cleanCallsign}`);
                const inferredResult = {
                    icao24,
                    callsign: cleanCallsign,
                    departureAirport: nearestAp.icao,
                    arrivalAirport: null,
                    isInferred: true,
                    source: 'spatial_inference'
                };
                routeCache.set(icao24, { data: inferredResult, timestamp: Date.now() });

                // Persist inferred route to MongoDB for future lookups
                if (cleanCallsign) {
                    Route.findOneAndUpdate(
                        { callsign: cleanCallsign },
                        {
                            departureAirport: nearestAp.icao,
                            arrivalAirport: null,
                            source: 'spatial_inference',
                            lastUpdated: new Date()
                        },
                        { upsert: true }
                    ).catch(err => console.error('[ROUTE PERSIST]', err.message));
                }

                return res.json(inferredResult);
            }
        }

        console.log(`⚠️ [ROUTE] ${cleanCallsign} not found in Local/Cache/Spatial. Returning noData.`);
        const noDataResult = { icao24, callsign: cleanCallsign, noData: true, source: 'none' };
        routeCache.set(icao24, { data: noDataResult, timestamp: Date.now() });
        return res.json(noDataResult);

    } catch (e) {
        res.json({ icao24, callsign: cleanCallsign, noData: true, error: e.message });
    }
});

// ==========================================
// [Phase 11] 外部航線備援 API (External Route Proxy)
// ==========================================
app.get('/api/route/external', async (req, res) => {
    const callsign = (req.query.callsign || '').toUpperCase().trim();
    if (!callsign) return res.status(400).json({ error: 'Callsign is required' });

    console.log(`🌐 [EXT-ROUTE] Processing request for ${callsign}...`);

    try {
        // --- Layer 1: MongoDB Cache (DB HIT) ---
        const dbRoute = await Route.findOne({ callsign });
        if (dbRoute && dbRoute.departureAirport && dbRoute.arrivalAirport) {
            console.log(`🎯 [DB HIT] Found complete route for ${callsign}: ${dbRoute.departureAirport} -> ${dbRoute.arrivalAirport}`);
            return res.json({
                callsign,
                departureAirport: dbRoute.departureAirport,
                arrivalAirport: dbRoute.arrivalAirport,
                source: 'mongodb_cache',
                lastUpdated: dbRoute.lastUpdated
            });
        }
        // Partial route (e.g., spatial_inference with dep only) — continue to try enriching

        console.log(`⚡ [DB MISS] No data in MongoDB for ${callsign}. Escalating to API/Mock...`);

        let externalData = null;

        // --- Layer 2: AirLabs API Proxy ---
        const AIRLABS_KEY = process.env.AIRLABS_API_KEY;
        if (AIRLABS_KEY) {
            const response = await fetch(`https://airlabs.co/api/v9/flights?flight_icao=${callsign}&api_key=${AIRLABS_KEY}`);
            if (response.ok) {
                const data = await response.json();
                if (data.response && data.response.length > 0) {
                    const flight = data.response[0];
                    externalData = {
                        dep: flight.dep_icao || flight.dep_iata,
                        arr: flight.arr_icao || flight.arr_iata,
                        source: 'airlabs_api'
                    };
                }
            }
        }

        // --- Layer 3: Smart Mock Fallback ---
        if (!externalData) {
            const MOCK_DB = {
                'JAL33': { dep: 'RJTT', arr: 'VTBS' },
                'JAL727': { dep: 'RJAA', arr: 'RPLL' },
                'APZ622': { dep: 'RKSI', arr: 'VTBS' },
                'CPA880': { dep: 'VHHH', arr: 'KLAX' },
                'JJA2104': { dep: 'RKSI', arr: 'RCTP' },
                'TTW603': { dep: 'RCTP', arr: 'ROAH' },
                'TGW875': { dep: 'RCTP', arr: 'WSSS' },
                'CAL6871': { dep: 'RCTP', arr: 'VHHH' },
                'AAR756': { dep: 'RPLL', arr: 'RKSI' },
                'CES739': { dep: 'ZSPD', arr: 'VTBS' },
                'HKE623': { dep: 'VHHH', arr: 'RCTP' },
            };
            if (MOCK_DB[callsign]) {
                externalData = {
                    dep: MOCK_DB[callsign].dep,
                    arr: MOCK_DB[callsign].arr,
                    source: 'smart_mock'
                };
            }
        }

        if (externalData) {
            // --- Layer 4: Persistence (SAVE TO DB) ---
            console.log(`💾 [DB SAVE] Persisting new route for ${callsign} to MongoDB...`);
            await Route.findOneAndUpdate(
                { callsign },
                {
                    departureAirport: externalData.dep,
                    arrivalAirport: externalData.arr,
                    lastUpdated: new Date()
                },
                { upsert: true, returnDocument: 'after' }
            );

            return res.json({
                callsign,
                departureAirport: externalData.dep,
                arrivalAirport: externalData.arr,
                source: externalData.source
            });
        }

        // 無法得知任何資訊
        return res.json({ callsign, noData: true, source: 'none' });

    } catch (err) {
        console.error('❌ [EXT-ROUTE] Cache Loop Error:', err);
        res.json({ callsign, noData: true, error: err.message });
    }
});

// ==========================================
// 飛機軌跡 Tracks API (過去 24 小時的飛行路徑)
// ==========================================
const trackCache = new Map();
const TRACK_CACHE_TTL = 30000; // 30 秒快取

/**
 * [Phase 7] Official OpenSky Track Integration & Fusion
 * Fetch tracks from official API and merge with local database points.
 */
async function fetchTracksInternal(icao24) {
    if (mongoose.connection.readyState !== 1) {
        return { icao24, path: [], error: 'Database not connected' };
    }
    
    // Check short-term memory cache
    const cached = trackCache.get(icao24);
    if (cached && (Date.now() - cached.timestamp < TRACK_CACHE_TTL)) {
        return cached.data;
    }

    try {
        const icao = icao24.toLowerCase();
        // 1. Get current local session
        let session = await FlightSession.findOne({ icao24: icao }).sort({ startTime: -1 }).lean();
        
        let localPoints = [];
        if (session) {
            localPoints = await TrackPoint.find({ sessionId: session.sessionId }).sort({ timestamp: 1 }).lean();
        }

        // [v10.5 Redesign] Robustness: If no session or sparse data, search by icao24 directly (last 12h)
        if (localPoints.length < 5) {
            const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
            const fallbackPoints = await TrackPoint.find({ 
                icao24: icao, 
                timestamp: { $gt: twelveHoursAgo } 
            }).sort({ timestamp: 1 }).limit(15000).lean();
            
            if (fallbackPoints.length > localPoints.length) {
                console.log(`📡 [TRACK FALLBACK] Found ${fallbackPoints.length} points for ${icao24} outside of session tracking.`);
                localPoints = fallbackPoints;
            }
        }
        
        // 3. Trigger Official OpenSky Fetch if local data is still sparse
        // Or if the session just started and the starting point is far from the current position.
        let mergedPath = localPoints.map(pt => [
            Math.floor(pt.timestamp.getTime() / 1000),
            pt.lat, pt.lng, pt.altitude || 0, pt.heading || 0, pt.velocity || 0, pt.onGround ? 1 : 0
        ]);

        if (localPoints.length < 60) {
            console.log(`📡 [TRACK FUSION] Fetching official OpenSky track for ${icao24}...`);
            try {
                const headers = await getAuthHeaders();
                const osRes = await fetch(`https://opensky-network.org/api/tracks/all?icao24=${icao}&time=0`, {
                    headers,
                    signal: AbortSignal.timeout(8000)
                });

                if (osRes.ok) {
                    const osTrack = await osRes.json();
                    if (osTrack.path && osTrack.path.length > 0) {
                        // OpenSky path format: [time, lat, lng, altitude, heading, onground]
                        // We need to merge these with our local points, favoring local for the overlapping most-recent parts
                        const osPathFormatted = osTrack.path.map(p => [
                            p[0], p[1], p[2], p[3] || 0, p[4] || 0, 0, p[5] ? 1 : 0
                        ]);

                        // Simple Time-based Merge (Favor Local for recent)
                        const localStart = mergedPath.length > 0 ? mergedPath[0][0] : Infinity;
                        const historicalPart = osPathFormatted.filter(p => p[0] < localStart);
                        
                        console.log(`✅ [TRACK FUSION] Merged ${historicalPart.length} historical points with ${mergedPath.length} local points.`);
                        mergedPath = [...historicalPart, ...mergedPath];

                        // Trigger Background Save for merged historical points (so we don't fetch from OS again)
                        // This prevents rate limiting by populating our DB with the full track once.
                        if (historicalPart.length > 0) {
                            (async () => {
                                const newDocs = historicalPart.map(p => ({
                                    sessionId: session.sessionId,
                                    icao24: icao,
                                    timestamp: new Date(p[0] * 1000),
                                    lat: p[1],
                                    lng: p[2],
                                    altitude: p[3],
                                    heading: p[4],
                                    velocity: p[5],
                                    onGround: p[6] === 1
                                }));
                                // Insert unique points only (ignore errors for duplicates)
                                try {
                                    await TrackPoint.insertMany(newDocs, { ordered: false });
                                } catch (e) { /* ignore duplicate errors */ }
                            })();
                        }
                    }
                }
            } catch (e) { console.warn(`⚠️ [TRACK FUSION] Official fetch failed for ${icao24}: ${e.message}`); }
        }

        const result = { icao24, path: mergedPath };
        trackCache.set(icao24, { data: result, timestamp: Date.now() });
        return result;

    } catch (e) {
        console.error(`❌ [TRACK ERROR] ${e.message}`);
        return { icao24, path: [], noData: true, error: e.message };
    }
}

app.get('/api/tracks', async (req, res) => {
    const icao24 = req.query.icao24;
    if (!icao24) return res.status(400).json({ error: 'Missing icao24' });
    const result = await fetchTracksInternal(icao24);
    res.json(result);
});

// ── Flight Session APIs (v7.0) ──────────────────────────────────────────

/**
 * GET /api/session/:id/track — Retrieve track for a specific session
 * Returns the exact track points belonging to one flight leg.
 */
app.get('/api/session/:id/track', async (req, res) => {
    const { id } = req.params;
    try {
        const session = await FlightSession.findOne({ sessionId: id }).lean();
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const points = await TrackPoint.find({ sessionId: id }).sort({ timestamp: 1 }).lean();

        res.json({
            sessionId: id,
            icao24: session.icao24,
            callsign: session.callsign,
            status: session.status,
            startTime: session.startTime,
            endTime: session.endTime,
            pointCount: points.length,
            path: points.map(pt => [
                Math.floor(pt.timestamp.getTime() / 1000),
                pt.lat,
                pt.lng,
                pt.altitude || 0,
                pt.heading || 0,
                pt.velocity || 0,
                pt.onGround ? 1 : 0
            ])
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/sessions/:icao24 — List all flight sessions for an aircraft
 * Returns session metadata (no track points) sorted by most recent first.
 * Query params: ?limit=20&status=ACTIVE
 */
app.get('/api/sessions/:icao24', async (req, res) => {
    const icao24 = req.params.icao24.toLowerCase();
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const filter = { icao24 };
    if (req.query.status) filter.status = req.query.status.toUpperCase();

    try {
        const sessions = await FlightSession.find(filter)
            .sort({ startTime: -1 })
            .limit(limit)
            .lean();

        // Attach point count for each session (lightweight aggregate)
        const sessionIds = sessions.map(s => s.sessionId);
        const counts = await TrackPoint.aggregate([
            { $match: { sessionId: { $in: sessionIds } } },
            { $group: { _id: '$sessionId', count: { $sum: 1 } } }
        ]);
        const countMap = new Map(counts.map(c => [c._id, c.count]));

        res.json(sessions.map(s => ({
            sessionId: s.sessionId,
            callsign: s.callsign,
            status: s.status,
            startTime: s.startTime,
            endTime: s.endTime,
            pointCount: countMap.get(s.sessionId) || 0,
            durationMin: s.endTime
                ? Math.round((new Date(s.endTime) - new Date(s.startTime)) / 60000)
                : null
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ==========================================
// METAR 機場天氣 API (每小時更新)
// ==========================================
const METAR_TTL = 3600000; // 1 小時

// 所有需要抓 METAR 的機場 ICAO 碼
const METAR_AIRPORTS = [
    'RCTP', 'RCSS', 'RCKH', 'RCMQ', 'RCNN', 'RCFN', 'RCQC',
    'RJTT', 'RJAA', 'RJBB', 'RJFF', 'RJCC', 'ROAH',
    'RKSI', 'RKSS',
    'ZBAA', 'ZSPD', 'ZSSS', 'ZGGG', 'ZGSZ', 'VHHH',
    'WSSS', 'VTBS', 'WMKK', 'RPLL', 'WIII', 'VVNB', 'VVTS', 'VIDP',
    'OMDB', 'OTHH',
    'EGLL', 'LFPG', 'EDDF', 'EHAM', 'LTFM',
    'KJFK', 'KLAX', 'KORD', 'KATL',
    'YSSY', 'NZAA'
];

async function fetchMetarData() {
    if (mongoose.connection.readyState !== 1) return;

    try {
        const ids = METAR_AIRPORTS.join(',');
        const url = `https://aviationweather.gov/api/data/metar?ids=${ids}&format=json`;
        console.log(`📡 [METAR] Fetching weather for ${METAR_AIRPORTS.length} airports...`);

        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`METAR API error: ${response.status}`);

        const data = await response.json();

        // 批次更新 MongoDB
        const operations = data.map(info => {
            const lng = parseFloat(info.lon);
            const lat = parseFloat(info.lat);

            return {
                updateOne: {
                    filter: { icaoId: info.icaoId.toUpperCase() },
                    update: {
                        $set: {
                            ...info,
                            location: {
                                type: 'Point',
                                coordinates: [lng, lat]
                            },
                            lastUpdated: new Date()
                        }
                    },
                    upsert: true
                }
            };
        });

        if (operations.length > 0) {
            await Metar.bulkWrite(operations, { ordered: false });
        }

        console.log(`📡 [METAR] Updated ${data.length} airport weather records in MongoDB`);
    } catch (error) {
        console.error('❌ [METAR] Fetch error:', error.message);
    }
}

// 啟動時啟動定時器
fetchMetarData(); // 立即執行一次

// 每小時定時更新
setInterval(fetchMetarData, METAR_TTL);

app.get('/api/metar', async (req, res) => {
    // [HOTFIX] 連線狀態守衛
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ error: 'Database not connected' });
    }

    try {
        const icao = req.query.icao;
        if (icao) {
            const found = await Metar.findOne({ icaoId: icao.toUpperCase() }).lean();
            return res.json(found || { error: 'Airport not found' });
        }
        const all = await Metar.find({}).lean();
        res.json(all);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// [API 404 防火牆]
// ==========================================
// [v9.0] Ultimate Data Fusion Endpoint (DB-First)
// ==========================================
app.get('/api/flight/complete-details/:hex/:callsign', async (req, res) => {
    const hex = req.params.hex.toLowerCase();
    const callsign = req.params.callsign.toUpperCase().trim();
    const cacheKey = `complete_${hex}_${callsign}`;

    try {
        // 1. Memory Cache Check (Fastest)
        const cached = flightDetailsCache.get(cacheKey);
        if (cached) return res.json({ ...cached, source: 'memory_cache' });

        // 2. [DB READ-THROUGH] Local Knowledge Base
        let [dbAircraft, dbRoute] = await Promise.all([
            Aircraft.findOne({ $or: [{ icao24: hex }, { hex: hex }] }).lean().catch(() => null),
            Route.findOne({ callsign }).lean().catch(() => null)
        ]);
        
        const AIRCRAFT_TTL = 30 * 24 * 60 * 60 * 1000; // 30 Days
        const ROUTE_TTL = 24 * 60 * 60 * 1000;       // 24 Hours
        
        const isAircraftFresh = dbAircraft && (Date.now() - new Date(dbAircraft.lastUpdated).getTime() < AIRCRAFT_TTL);
        const isRouteFresh = dbRoute && (Date.now() - new Date(dbRoute.lastUpdated).getTime() < ROUTE_TTL);
        
        // --- Step 2: [ABSOLUTE PRIMARY SOURCE] Mandatory OpenSky Status ---
        // We always fetch live state to ensure the plane is active, even if metadata is cached.
        console.log(`📡 [FUSION] Fetching Mandatory State for ${hex}...`);
        const osRes = await fetchOpenSky({ icao24: hex }).catch(e => {
            console.error(`❌ [PRIMARY FAIL] OpenSky Unresponsive: ${e.message}`);
            return null;
        });

        if (!osRes || !osRes.states || osRes.states.length === 0) {
            return res.status(500).json({ 
                error: 'PRIMARY_SOURCE_UNAVAILABLE', 
                message: 'OpenSky Network (Primary Source) failed to provide live status. Request aborted to ensure data integrity.' 
            });
        }
        const liveState = osRes.states[0];

        // If both Aircraft and Route are fresh in DB, we skip enrichment but STILL use the latest OpenSky state
        if (isAircraftFresh && isRouteFresh) {
            console.log(`🎯 [DB HIT] Serving cached knowledge for ${hex}/${callsign}`);
            const fused = await finalizeProfile(dbAircraft, dbRoute, liveState);
            flightDetailsCache.set(cacheKey, fused);
            return res.json({ ...fused, source: 'db_knowledge_base' });
        }

        console.log(`⚡ [ENRICHMENT] DB Stale or Missing. Fusing external sources...`);
        // --- Step 3: [RESILIENT ENRICHMENT] Multi-Source Parallel Fetch ---
        const enrichment = await Promise.allSettled([
            // a. HexDB (Static Specs)
            fetch(`https://hexdb.io/api/v1/aircraft/${hex}`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok ? r.json() : null).catch(() => null),
            // b. Planespotters (Visuals)
            fetch(`https://api.planespotters.net/pub/photos/hex/${hex}`, { headers: { 'User-Agent': 'AEROSTRAT/5.0' }, signal: AbortSignal.timeout(4000) }).then(r => r.ok ? r.json() : null).catch(() => null),
            // c. Route API (Flights/Schedules)
            fetchRouteData(callsign)
        ]);
 
        const [hexRes, photoRes, routeRes] = enrichment.map(r => r.status === 'fulfilled' ? r.value : null);
        
        // --- Step 4: [PERSISTENCE] Smart Normalization & Upsert ---
        // Aircraft Metadata (Manual mapping to standardized fields)
        const aircraftUpdate = {
            hex,
            icao24: hex,
            type: hexRes?.typeName || hexRes?.type || dbAircraft?.type || dbAircraft?.model || 'Unknown',
            model: hexRes?.typeName || hexRes?.type || dbAircraft?.model || 'Unknown',
            manufacturer: hexRes?.icaotype || dbAircraft?.manufacturer || 'Unknown',
            registration: hexRes?.registration || dbAircraft?.registration || 'N/A',
            airline: hexRes?.operator || dbAircraft?.airline || dbAircraft?.registered_owner || 'Unknown Airline',
            registered_owner: hexRes?.operator || dbAircraft?.registered_owner || 'Unknown Airline',
            photo_url: photoRes?.photos?.[0]?.thumbnail_large?.src || dbAircraft?.photo_url || dbAircraft?.photoData?.url || null,
            lastUpdated: new Date()
        };
        const updatedAircraft = await Aircraft.findOneAndUpdate({ $or: [{ icao24: hex }, { hex: hex }] }, { $set: aircraftUpdate }, { upsert: true, returnDocument: 'after' }).lean();
 
        // Flight Route Info
        const routeUpdate = {
            callsign,
            origin_iata: routeRes?.origin_iata || dbRoute?.origin_iata || 'N/A',
            destination_iata: routeRes?.destination_iata || dbRoute?.destination_iata || '---',
            estimated_arrival_time: routeRes?.estimated_arrival_time || dbRoute?.estimated_arrival_time || null,
            departureAirport: routeRes?.origin_iata || dbRoute?.departureAirport,
            arrivalAirport: routeRes?.destination_iata || dbRoute?.arrivalAirport,
            lastUpdated: new Date()
        };
        const updatedRoute = await Route.findOneAndUpdate({ callsign }, { $set: routeUpdate }, { upsert: true, returnDocument: 'after' }).lean();
 
        // --- Step 5: [FINAL ASSEMBLY] Profile Serialization & Caching ---
        const finalProfile = await finalizeProfile(updatedAircraft, updatedRoute, liveState);
        flightDetailsCache.set(cacheKey, finalProfile);
        res.json({ ...finalProfile, source: 'api_fusion_complete' });

    } catch (err) {
        console.error(`❌ [ULIMATE FUSION] Critical Failure for ${hex}:`, err.message);
        res.status(500).json({ error: 'Fusion endpoint failed', details: err.message });
    }
});

/**
 * Helper to finalize the profile object and inject weather
 */
async function finalizeProfile(aircraft, route, liveState = null) {
    // Inject METAR if arrival is known
    let weather = null;
    const destIata = route.destination_iata || route.arrivalAirport;
    if (destIata && destIata !== '---' && destIata !== 'N/A') {
        try {
            const airport = await Airport.findOne({ $or: [{ iata: destIata }, { icao: destIata }] }).lean();
            if (airport && airport.icao) {
                weather = await fetchMetar(airport.icao);
                
                // If we got weather, non-blocking update to Route to cache it
                if (weather && route.callsign) {
                    Route.updateOne({ callsign: route.callsign }, { $set: { destination_weather: weather } }).catch(() => null);
                }
            }
        } catch (e) {}
    }

    return {
        hex: aircraft.hex || aircraft.icao24,
        callsign: route.callsign,
        status: {
            alt: liveState?.altitude || 0,
            gs: liveState?.velocity || 0,
            track: liveState?.heading || 0,
            lat: liveState?.lat || 0,
            lon: liveState?.lng || 0,
            squawk: liveState?.squawk || '0000',
            onGround: !!liveState?.onGround,
            timestamp: liveState?.lastContact || Math.floor(Date.now() / 1000)
        },
        route: {
            origin: { iata: route.origin_iata || 'N/A' },
            destination: { iata: route.destination_iata || '---' },
            arrival: route.estimated_arrival_time,
            weather: weather || route.destination_weather || null
        },
        aircraft: {
            type: aircraft.type || aircraft.model,
            model: aircraft.model,
            registration: aircraft.registration,
            airline: aircraft.airline || aircraft.registered_owner,
            manufacturer: aircraft.manufacturer,
            photo_url: aircraft.photo_url || aircraft.photoData?.url || null
        },
        last_updated: aircraft.lastUpdated
    };
}



app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});


// ==========================================
// 自動化資料庫引擎 (Background Auto-Sync)
// ==========================================
async function syncSchedulesDatabase() {
    console.log('⚙️ [AUTO-SYNC] Starting daily database synchronization...');
    try {
        // [數據獲取] 這裡使用的是一個開源的、定期更新的航班班表來源範例
        // 實際部署時使用者可以根據需要修改此 URL
        const SCHEDULES_URL = 'https://raw.githubusercontent.com/LiaoCho/flight-data-source/main/schedules_latest.json';

        console.log(`📡 [AUTO-SYNC] Downloading latest data from ${SCHEDULES_URL}...`);

        // 設定較短的逾時，避免阻塞事件循環
        const response = await fetch(SCHEDULES_URL, { signal: AbortSignal.timeout(60000) });

        if (!response.ok) {
            console.warn(`⚠️ [AUTO-SYNC] Failed to download schedules: ${response.status}. Using existing local data.`);
            return;
        }

        const newData = await response.json();
        // [OPT 4.3] 修復路徑：使用與 loadGlobalData 相同的路徑 (data/schedules_static.json)
        const SCHEDULE_FILE = SCHEDULES_STATIC_FILE;

        // 寫入修正後的路徑 (async — 避免阻塞事件循環)
        await fs.promises.writeFile(SCHEDULE_FILE, JSON.stringify(newData, null, 2));

        // 同步完成後更新記憶體中的變數
        schedulesStaticDB = newData;

        console.log(`✅ [AUTO-SYNC] Successfully synced ${Object.keys(newData).length} flights. Schedules updated.`);
    } catch (error) {
        console.error('❌ [AUTO-SYNC] Critical synchronization error:', error.message);
    }
}

// 設定每日凌晨 3 點 (伺服器離峰時間) 執行任務
cron.schedule('0 3 * * *', () => {
    syncSchedulesDatabase();
}, {
    timezone: "Asia/Taipei"
});

// 每 15 分鐘抓取一次 TDX 進出港資料 (Real-time Schedules)
cron.schedule('*/15 * * * *', () => {
    crawlFlightSchedules();
}, {
    timezone: "Asia/Taipei"
});

// ==========================================
// [v11.0] Tactical Background Resolution
// ==========================================
/**
 * Triggers a non-blocking background metadata lookup for new aircraft.
 * Uses the flightController's internal waterfall resolution to populate MongoDB.
 */
const pendingResolutions = new Set();
function triggerBackgroundResolution(hex, callsign) {
    if (pendingResolutions.has(hex)) return;
    pendingResolutions.add(hex);

    (async () => {
        try {
            // Lazy load required controller
            const { getCompleteDetailsInternal } = require('./controllers/flightController');
            if (typeof getCompleteDetailsInternal === 'function') {
                await getCompleteDetailsInternal(hex, callsign);
            }
        } catch (e) {
            // Silently fail, it's a background optimization
        } finally {
            // Limit rate of resolutions to 2 per sec to avoid hitting APIs too hard
            setTimeout(() => pendingResolutions.delete(hex), 500); 
        }
    })();
}

// 啟動伺服器
async function startServer() {
    // 1. Build Metadata Index (Instant SILHOUETTE support)
    await initAircraftMetadataIndex();

    // 2. Start HTTP & WS
    const server = http.createServer(app);
    initWebSocketServer(server);

    server.listen(PORT, () => {
        const readyTime = new Date().toLocaleTimeString();
        const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        console.log('');
        console.log('╔══════════════════════════════════════════╗');
        console.log('║   ✈️  AEROSTRAT API Engine (Hybrid)       ║');
        console.log(`║   🌐 API: http://localhost:${PORT}            ║`);
        console.log(`║   🔌 WS:  ws://localhost:${PORT}/ws           ║`);
        console.log(`║   🔐 Version: ${AEROSTRAT_VERSION} (Hybrid Sync)      ║`);
        console.log(`║   ⏱️  Ready: ${readyTime}                 ║`);
        console.log(`║   💾 Heap: ${memMB}MB                          ║`);
        console.log(`║   📋 Logs: backend/logs/                  ║`);
        console.log('╚══════════════════════════════════════════╝');
        console.log('');
        logger.info('SERVER', `AEROSTRAT ${AEROSTRAT_VERSION} started on port ${PORT} | heap: ${memMB}MB | LOG_LEVEL: ${process.env.LOG_LEVEL || 'INFO'}`);
    });
}

startServer();
