const config = require('./config');
const logger = require('./logger');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { Worker } = require('worker_threads');
const http = require('http');
const zlib = require('zlib');
const readline = require('readline');
const { initWebSocketServer, broadcastPlanes, broadcastTelemetry, getActiveViewports, getClientCount } = require('./socketEngine');
// ── New store layer (replaces MongoDB models) ───────────────────────────
const Aircraft      = require('./db/aircraftStore');
const Route         = require('./db/routeStore');
const Metar         = require('./db/metarStore');
const FlightSession = require('./db/sessionStore');
const TrackPoint    = require('./db/trackStore');
const staticMaps    = require('./db/staticMaps');
const { AircraftShape } = staticMaps;
// AircraftRegistry → in-memory Map (circuit-breaker state, no persistence needed)
const _registryCache = new Map(); // icao24 → { apiStatus, blockedUntil, ...metadata }
const AircraftRegistry = {
    findOne: (q) => Promise.resolve(_registryCache.get((q?.icao24 || '').toLowerCase()) || null),
    findOneAndUpdate: (filter, update) => {
        const key = (filter?.icao24 || '').toLowerCase();
        const existing = _registryCache.get(key) || {};
        const data = { ...existing, ...(update?.$set || update), icao24: key };
        _registryCache.set(key, data);
        return Promise.resolve(data);
    },
};
// ActiveFlight → removed; masterStateMap is the authoritative in-memory store
const ActiveFlight = {
    findOne:         ()    => Promise.resolve(null),
    find:            ()    => Promise.resolve([]),
    bulkWrite:       ()    => Promise.resolve({ modifiedCount: 0 }),
    findOneAndUpdate: ()   => Promise.resolve(null),
};
// ── Legacy Airport model shim (spatial queries done in-memory) ───────────
const Airport = {
    find: () => ({ lean: () => Promise.resolve([]) }),
    findOne: () => Promise.resolve(null),
};
const { crawlFlightSchedules } = require('./crawler');
const NodeCache = require('node-cache');
const flightController = require('./controllers/flightController');
const AEROSTRAT_VERSION = 'v10.5-Hybrid';
const AccountPool = require('./accountPool');

// ==========================================
// [v4.4.0] Logging Helper with Tactical Timestamps
// ==========================================
function getTime() {
    return `[${new Date().toLocaleTimeString('en-US', { hour12: false })}]`;
}

// ==========================================
// [v12.0] SQLite + Store Initialization (replaces MongoDB)
// ==========================================
(async function initStores() {
    try {
        // SQLite is initialized synchronously on require
        require('./db/sqlite');
        logger.info('DATABASE', '✅ SQLite initialized (WAL mode)');

        // Purge poisoned spatial_inference routes from route store
        Route.deleteMany({ source: 'spatial_inference' })
            .then(r => { if (r.deletedCount > 0) logger.info('ROUTE', `Purged ${r.deletedCount} spatial_inference route(s)`); })
            .catch(() => null);

        // Restore active sessions from SQLite
        if (typeof restoreActiveSessions === 'function') await restoreActiveSessions();
        if (typeof buildAirportListCache   === 'function') buildAirportListCache();

        // Load static OSINT data into in-memory maps
        (async () => {
            try {
                const { initOsintData } = require('./scripts/syncOsintData');
                await initOsintData().catch(err => logger.warn('OSINT', `Sync failed (non-fatal): ${err.message}`));
            } catch (_) {}
        })();
    } catch (err) {
        logger.error('DATABASE', `Store init error: ${err.message}`);
    }
})();

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

// [v5.0.0] Production static file serving — built frontend from public-react/
// In development, Vite dev server handles the frontend on port 3005.
// In production (Docker), serve the pre-built React app directly.
const publicReactPath = path.join(__dirname, '..', 'public-react');
if (fs.existsSync(publicReactPath)) {
    app.use(express.static(publicReactPath, { maxAge: '1h' }));
    // Express 5 wildcard syntax: serve index.html for all non-API routes (SPA fallback)
    app.get('/{*path}', (req, res, next) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/ws') || req.path === '/monitor') return next();
        res.sendFile(path.join(publicReactPath, 'index.html'));
    });
    logger.info('SERVER', `Serving built frontend from ${publicReactPath}`);
}

// [v12.5] Aircraft SVG silhouettes served locally (avoids GitHub CDN 404s/rate-limits)
// Known-missing types get a generic jet silhouette instead of a 404 to suppress console noise.
app.use('/api/svg', express.static(path.join(__dirname, 'public/svg'), {
    maxAge: '7d',
    fallthrough: true,
    setHeaders: (res) => { res.setHeader('Access-Control-Allow-Origin', '*'); }
}));
app.get('/api/svg/:typecode', (req, res) => {
    // Fallback: serve generic jet SVG for unknown typecodes — suppresses 404 noise
    const fallback = path.join(__dirname, 'public/svg/A320.svg');
    if (fs.existsSync(fallback)) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(fallback);
    } else {
        res.status(204).end(); // no content, still 2xx
    }
});


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
        Aircraft.findOne({ icao24: hex }) .catch(() => null)
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
const lastStoredPoint = new Map(); // [Track Dedup] icao24 -> { lat, lng, altitude, heading, velocity, ts }

// [v8.0] BFF Aggregator Caches
const flightDetailsCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 }); // 30 min TTL [Phase 9]
const liveDataFallbackCache = new NodeCache({ stdTTL: 10, checkperiod: 5 }); // 10s TTL for live fallback

// ==========================================
// [SESSION HYDRATION] 伺服器重啟時的智慧記憶恢復
// ==========================================
async function restoreActiveSessions() {
    try {
        const activeSessionsInDb = await FlightSession.find({ status: 'ACTIVE' });
        let restoredCount = 0;
        let closedCount = 0;
        const now = Date.now();
        const STALE_THRESHOLD = 60 * 60 * 1000; // 嚴格定義：1 小時內沒更新的航班，視為已結束

        for (const session of activeSessionsInDb) {
            // 找出最後一筆軌跡點 (SQLite)
            const lastPoint = await TrackPoint.findOne({ sessionId: session.sessionId });

            if (lastPoint && (now - lastPoint.timestamp.getTime() < STALE_THRESHOLD)) {
                activeSessions.set(session.icao24, {
                    sessionId: session.sessionId,
                    callsign: session.callsign || 'N/A',
                    lastSeen: lastPoint.timestamp.getTime(),
                    onGround: !!lastPoint.onGround
                });
                restoredCount++;
            } else {
                const endTime = lastPoint ? lastPoint.timestamp : new Date();
                await FlightSession.bulkWrite([{
                    updateOne: { filter: { sessionId: session.sessionId }, update: { $set: { status: 'COMPLETED', endTime } } }
                }]);
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
// OpenSky API 多帳號池（AccountPool）
// ==========================================
const _rawAccounts = [
    { user: process.env.OPENSKY_USER1 || process.env.OPENSKY_USER, pass: process.env.OPENSKY_PASS1 || process.env.OPENSKY_PASS },
    { user: process.env.OPENSKY_USER2, pass: process.env.OPENSKY_PASS2 },
    { user: process.env.OPENSKY_USER3, pass: process.env.OPENSKY_PASS3 },
    { user: process.env.OPENSKY_USER4, pass: process.env.OPENSKY_PASS4 },
    { user: process.env.OPENSKY_USER5, pass: process.env.OPENSKY_PASS5 },
].filter(a => a.user && a.pass);

const QUOTA_CACHE_FILE = path.join(__dirname, 'quota-cache.json');
const accountPool = new AccountPool(_rawAccounts, { safeFloor: 50 });

// ==========================================
// 動作紀錄 API (讓前端的操作顯示在後台終端並寫入 log 檔)
app.post('/api/log', (req, res) => {
    const { message, type = 'info', data = {} } = req.body;
    // 安全：清除換行符號防止 log injection（OWASP CWE-117）
    const safeMsg = String(message ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 500);
    const safeType = ['error', 'warn', 'info'].includes(type) ? type : 'info';
    const hasData = data && typeof data === 'object' && Object.keys(data).length > 0;
    const logData = hasData ? data : undefined;
    if (safeType === 'error')      logger.error('CLIENT', safeMsg, logData);
    else if (safeType === 'warn')  logger.warn('CLIENT', safeMsg, logData);
    else                           logger.info('CLIENT', safeMsg, logData);
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

// ── System Monitor Dashboard (/monitor) ───────────────────────
// Protected by MONITOR_TOKEN env var (預設 'dev' 僅限本機開發).
// 生產環境請在 .env 設定 MONITOR_TOKEN=<強密碼>
// Access: http://localhost:3000/monitor?token=<MONITOR_TOKEN>
const MONITOR_TOKEN = process.env.MONITOR_TOKEN || 'dev';
if (MONITOR_TOKEN === 'dev' && process.env.NODE_ENV === 'production') {
    logger.warn('SECURITY', '[ALERT] MONITOR_TOKEN is using default "dev" in production! Set MONITOR_TOKEN in .env');
}

app.get('/monitor', (req, res) => {
    if (req.query.token !== MONITOR_TOKEN) {
        return res.status(401).send(`
            <html><body style="background:#060810;color:#ef4444;font-family:monospace;padding:40px">
            <h2>401 Unauthorized</h2>
            <p>Provide <code>?token=YOUR_MONITOR_TOKEN</code></p>
            <p>Default token during development: <code>dev</code></p>
            </body></html>`);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(getMonitorHtml());
});

function getMonitorHtml() {
    return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AEROSTRAT &mdash; System Monitor</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#04060d;--s:#0a0f1e;--s2:#0f1628;
  --b:rgba(148,163,184,.08);--bh:rgba(148,163,184,.16);
  --t:#e2e8f0;--td:#64748b;--tm:#3d4f63;
  --cyan:#22d3ee;--green:#10b981;--amber:#f59e0b;--red:#ef4444;--purple:#a855f7;
  --font:'JetBrains Mono',Consolas,monospace;
}
html,body{min-height:100vh;background:var(--bg);color:var(--t);font-family:var(--font);font-size:15px}
a{color:var(--cyan);text-decoration:none}
a:hover{opacity:.8}
#wrap{max-width:1280px;margin:0 auto;padding:24px 20px}
.hd{display:flex;align-items:center;justify-content:space-between;padding:0 0 20px;border-bottom:1px solid var(--b);margin-bottom:24px}
.hd-brand{font-size:22px;font-weight:700;letter-spacing:.15em;background:linear-gradient(135deg,var(--cyan),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hd-sub{font-size:12px;color:var(--td);margin-top:3px}
.hd-sync{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--td)}
.sync-dot{width:9px;height:9px;border-radius:50%;background:var(--amber);flex-shrink:0;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.75)}}
.stat-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px}
.stat-card{background:var(--s);border:1px solid var(--b);border-radius:12px;padding:18px 22px;position:relative;overflow:hidden;transition:border-color .3s}
.stat-card:hover{border-color:var(--bh)}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0}
.stat-card.cyan::before{background:linear-gradient(90deg,var(--cyan),transparent)}
.stat-card.green::before{background:linear-gradient(90deg,var(--green),transparent)}
.stat-card.amber::before{background:linear-gradient(90deg,var(--amber),transparent)}
.stat-card.purple::before{background:linear-gradient(90deg,var(--purple),transparent)}
.stat-val{font-size:30px;font-weight:700;color:var(--t);line-height:1;margin-bottom:5px}
.stat-lbl{font-size:11px;color:var(--td);letter-spacing:.12em;text-transform:uppercase}
.stat-trend{font-size:11px;color:var(--tm);margin-top:5px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.grid-full{margin-bottom:16px}
@media(max-width:900px){.grid{grid-template-columns:1fr}.stat-bar{grid-template-columns:repeat(2,1fr)}}
.card{background:var(--s);border:1px solid var(--b);border-radius:12px;overflow:hidden}
.card-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--b);background:rgba(10,15,30,.6)}
.card-title{font-size:12px;font-weight:700;letter-spacing:.1em;color:var(--td);text-transform:uppercase}
.card-badge{font-size:12px;font-weight:700;color:var(--cyan);background:rgba(34,211,238,.1);padding:4px 10px;border-radius:5px;border:1px solid rgba(34,211,238,.2)}
.card-body{padding:18px}
.accts-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.acct-card{background:var(--s2);border:1px solid var(--b);border-radius:10px;padding:20px 16px;display:flex;flex-direction:column;align-items:center;gap:10px;transition:all .3s}
.acct-card.is-active{border-color:rgba(34,211,238,.45);box-shadow:0 0 24px rgba(34,211,238,.1)}
.acct-card.is-locked{border-color:rgba(239,68,68,.25);opacity:.72}
.ring-wrap{position:relative;width:90px;height:90px;flex-shrink:0}
.ring-wrap svg{transform:rotate(-90deg);display:block}
.ring-bg{fill:none;stroke:rgba(255,255,255,.05);stroke-width:7}
.ring-fill{fill:none;stroke-width:7;stroke-linecap:round;transition:stroke-dasharray .7s cubic-bezier(.4,0,.2,1)}
.ring-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;line-height:1.3}
.ring-pct{font-size:17px;font-weight:700}
.ring-sub{font-size:9px;color:var(--td);text-transform:uppercase;letter-spacing:.05em}
.acct-name{font-size:13px;font-weight:600;color:var(--t);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.acct-credits-lbl{font-size:12px;color:var(--td);text-align:center}
.acct-status-badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:4px;letter-spacing:.08em}
.acct-status-badge.s-active{color:var(--cyan);background:rgba(34,211,238,.12);border:1px solid rgba(34,211,238,.3)}
.acct-status-badge.s-standby{color:var(--td);background:rgba(100,116,139,.1);border:1px solid rgba(100,116,139,.2)}
.acct-status-badge.s-locked{color:var(--red);background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25)}
.unlock-time{font-size:11px;color:var(--red);opacity:.8}
.acct-meta{display:flex;gap:14px;font-size:11px;color:var(--tm)}
.sources{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.src-pill{display:flex;align-items:center;gap:6px;padding:5px 13px;border-radius:20px;font-size:12px;font-weight:600;border:1px solid}
.src-pill.up{color:var(--green);border-color:rgba(16,185,129,.3);background:rgba(16,185,129,.06)}
.src-pill.down{color:var(--red);border-color:rgba(239,68,68,.3);opacity:.65}
.src-pill.cb{color:var(--amber);border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.06)}
.src-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}
.row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--b);font-size:13px}
.row:last-child{border-bottom:none}
.lbl{color:var(--td)}
.val{color:var(--t);font-weight:600;text-align:right}
.val.ok{color:var(--green)}.val.warn{color:var(--amber)}.val.err{color:var(--red)}.val.dim{color:var(--tm)}
.skel{background:linear-gradient(90deg,var(--s) 25%,var(--s2) 50%,var(--s) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:5px;height:15px;opacity:.5}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
footer{text-align:center;padding:24px 0;color:var(--tm);font-size:12px;margin-top:8px;border-top:1px solid var(--b)}
</style>
</head>
<body>
<div id="wrap">
  <div class="hd">
    <div>
      <div class="hd-brand">&#x2708; AEROSTRAT MONITOR</div>
      <div class="hd-sub" id="last-updated">&#x8F09;&#x5165;&#x4E2D;&#x2026;</div>
    </div>
    <div class="hd-sync">
      <div class="sync-dot" id="sync-dot"></div>
      <span id="sync-label">&#x9023;&#x63A5;&#x4E2D;&#x2026;</span>
      &nbsp;&middot;&nbsp; &#x6BCF; 5 &#x79D2;&#x66F4;&#x65B0;
      &nbsp;&middot;&nbsp; <a href="/" target="_blank">&#x2190; &#x4E3B;&#x4ECB;&#x9762;</a>
    </div>
  </div>
  <div class="stat-bar" id="stat-bar">
    <div class="stat-card cyan"><div class="stat-val skel" style="width:90px;height:30px"> </div><div class="stat-lbl">AIRCRAFT</div></div>
    <div class="stat-card green"><div class="stat-val skel" style="width:70px;height:30px"> </div><div class="stat-lbl">SYNC CYCLE</div></div>
    <div class="stat-card amber"><div class="stat-val skel" style="width:90px;height:30px"> </div><div class="stat-lbl">TRACK PTS</div></div>
    <div class="stat-card purple"><div class="stat-val skel" style="width:70px;height:30px"> </div><div class="stat-lbl">UPTIME</div></div>
  </div>
  <div class="card grid-full">
    <div class="card-hd">
      <span class="card-title">&#x1F511; OpenSky &#x5E33;&#x865F;&#x984D;&#x5EA6;</span>
      <span class="card-badge" id="acct-badge">&#x2014;</span>
    </div>
    <div class="card-body">
      <div id="accounts-body" class="accts-grid">
        <div class="skel" style="height:190px;border-radius:10px"></div>
        <div class="skel" style="height:190px;border-radius:10px"></div>
        <div class="skel" style="height:190px;border-radius:10px"></div>
      </div>
    </div>
  </div>
  <div class="grid">
    <div class="card">
      <div class="card-hd">
        <span class="card-title">&#x27F3; &#x540C;&#x6B65;&#x72C0;&#x614B;</span>
        <span class="card-badge" id="sync-badge">&#x2014;</span>
      </div>
      <div class="card-body">
        <div id="sources-bar" class="sources"></div>
        <div id="sync-body"><div class="skel" style="margin:10px 0"></div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-hd">
        <span class="card-title">&#x25C8; &#x9023;&#x7DDA; / &#x7CFB;&#x7D71;</span>
        <span class="card-badge" id="ws-badge">&#x2014;</span>
      </div>
      <div class="card-body" id="ws-body"><div class="skel" style="margin:10px 0"></div></div>
    </div>
    <div class="card">
      <div class="card-hd">
        <span class="card-title">&#x25C9; &#x8CC7;&#x6599;&#x5438;&#x6536;</span>
        <span class="card-badge" id="ingest-badge">&#x2014;</span>
      </div>
      <div class="card-body" id="ingest-body"><div class="skel" style="margin:10px 0"></div></div>
    </div>
    <div class="card">
      <div class="card-hd">
        <span class="card-title">&#x1F4CA; API &#x7D71;&#x8A08;</span>
        <span class="card-badge" id="api-badge">&#x2014;</span>
      </div>
      <div class="card-body" id="api-body"><div class="skel"></div></div>
    </div>
  </div>
  <footer>AEROSTRAT System Monitor &nbsp;&middot;&nbsp; <a href="?token=${MONITOR_TOKEN}">&#x91CD;&#x65B0;&#x6574;&#x7406;</a></footer>
</div>
<script>
const QUOTA_MAX = 4000;
let lastCycle = null;
function row(lbl, val, cls) {
  return '<div class="row"><span class="lbl">' + lbl + '</span><span class="val ' + (cls||'') + '">' + val + '</span></div>';
}
function ringGauge(pct, color) {
  var r = 38, circ = +(2 * Math.PI * r).toFixed(2);
  var filled = +((pct / 100) * circ).toFixed(2);
  return '<svg width="90" height="90" viewBox="0 0 90 90">' +
    '<circle class="ring-bg" cx="45" cy="45" r="' + r + '"/>' +
    '<circle class="ring-fill" cx="45" cy="45" r="' + r + '" stroke="' + color + '" stroke-dasharray="' + filled + ' ' + circ + '"/>' +
    '</svg>';
}
function acctCard(a, activeUser) {
  var locked = !!(a.unlockTime && new Date(a.unlockTime) > new Date());
  var credits = a.remainingCredits != null ? a.remainingCredits : 0;
  var pct = locked ? 0 : Math.min(100, Math.round((credits / QUOTA_MAX) * 100));
  var color = locked ? '#ef4444' : pct > 60 ? '#10b981' : pct > 25 ? '#f59e0b' : '#ef4444';
  var isActive = a.user === activeUser;
  var shortName = (a.user || '').replace(/-api-client$/, '');
  var unlockLocal = locked ? new Date(a.unlockTime).toLocaleTimeString('zh-TW', {hour:'2-digit',minute:'2-digit'}) : '';
  var cardCls = isActive ? 'is-active' : locked ? 'is-locked' : '';
  var badgeCls = isActive ? 's-active' : locked ? 's-locked' : 's-standby';
  var badgeTxt = isActive ? '&#x25CF; ACTIVE' : locked ? '&#x1F512; LOCKED' : '&#x25CB; STANDBY';
  return '<div class="acct-card ' + cardCls + '">' +
    '<div class="ring-wrap">' + ringGauge(pct, color) +
    '<div class="ring-center"><div class="ring-pct" style="color:' + color + '">' + pct + '%</div><div class="ring-sub">QUOTA</div></div></div>' +
    '<div class="acct-name">' + shortName + '</div>' +
    '<span class="acct-status-badge ' + badgeCls + '">' + badgeTxt + '</span>' +
    (locked ? '<div class="unlock-time">&#x89E3;&#x9396; ' + unlockLocal + '</div>' : '') +
    '<div class="acct-credits-lbl">' + (locked ? '&#x2014; / ' : credits.toLocaleString() + ' / ') + QUOTA_MAX.toLocaleString() + '</div>' +
    '<div class="acct-meta"><span title="&#x4ECA;&#x65E5;&#x5DF2;&#x7528;">&#x1F4E4; ' + (a.dailyUsed||0) + '</span>' +
    '<span title="&#x7D2F;&#x8A08;429">&#x26A0; ' + (a.rateLimits||0) + '</span></div></div>';
}
function statCard(val, lbl, cls, trend) {
  return '<div class="stat-card ' + cls + '"><div class="stat-val">' + val + '</div><div class="stat-lbl">' + lbl + '</div>' + (trend ? '<div class="stat-trend">' + trend + '</div>' : '') + '</div>';
}
function srcPill(name, status) {
  return '<div class="src-pill ' + status + '"><span class="src-dot"></span>' + name + '</div>';
}
async function refresh() {
  try {
    var [health, stats] = await Promise.all([
      fetch('/api/health').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
    ]);
    document.getElementById('sync-dot').style.background = '#10b981';
    document.getElementById('sync-label').textContent = '&#x5373;&#x6642;&#x540C;&#x6B65;';
    document.getElementById('last-updated').textContent = '&#x6700;&#x5F8C;&#x66F4;&#x65B0;&#xFF1A;' + new Date().toLocaleTimeString('zh-TW');
    var ing = health.ingestion || {};
    var upSec = health.uptime || 0;
    var upStr = upSec >= 3600 ? Math.floor(upSec/3600) + 'h ' + Math.floor((upSec%3600)/60) + 'm' : Math.floor(upSec/60) + ' min';
    var batchMs = ing.lastBatchMs || 0;
    var batchCls = batchMs < 2000 ? 'ok' : batchMs < 5000 ? 'warn' : 'err';
    document.getElementById('stat-bar').innerHTML =
      statCard((health.cacheSize||0).toLocaleString(), 'AIRCRAFT', 'cyan', '&#x5373;&#x6642;&#x98DB;&#x6A5F;&#x7E3D;&#x6578;') +
      statCard('#' + (ing.totalBatches||0), 'SYNC CYCLE', 'green', '&#x4E0A;&#x6B21; ' + batchMs + 'ms') +
      statCard((ing.totalPoints||0).toLocaleString(), 'TRACK PTS', 'amber', 'TTL 48h') +
      statCard(upStr, 'UPTIME', 'purple', (health.activeAccount||'').replace(/-api-client$/,''));
    var accts = stats.accounts || [];
    var activeUser = health.activeAccount;
    var activeCount = accts.filter(a => !a.unlockTime || new Date(a.unlockTime) <= new Date()).length;
    var totalCredits = accts.reduce(function(s,a){ return s+(a.remainingCredits||0); }, 0);
    document.getElementById('acct-badge').textContent = activeCount + ' / ' + accts.length + ' \u53EF\u7528\u3000\u7E3D\u984D\u5EA6 ' + totalCredits.toLocaleString();
    document.getElementById('accounts-body').innerHTML = accts.map(a => acctCard(a, activeUser)).join('');
    document.getElementById('sources-bar').innerHTML =
      srcPill('adsb.lol','up') + srcPill('OpenSky', activeCount>0?'up':'cb') +
      srcPill('AL-Mil','up') + srcPill('AL-Point','up') + srcPill('adsb.fi','up');
    document.getElementById('sync-badge').textContent = 'Cycle #' + (ing.totalBatches||'—');
    document.getElementById('sync-body').innerHTML =
      row('\u4E0A\u6B21\u6279\u6B21', (ing.lastBatchSize||0) + ' \u67B6\u3000' + batchMs + 'ms', batchCls) +
      row('\u6D3B\u8E8D\u5E33\u865F', (health.activeAccount||'').replace(/-api-client$/,''), 'ok') +
      row('Sessions \u5EFA\u7ACB', (ing.sessionsCreated||0).toLocaleString(), '') +
      row('Sessions \u95DC\u9589', (ing.sessionsClosed||0).toLocaleString(), 'dim');
    var wsCls = health.status === 'ok' ? 'ok' : 'err';
    document.getElementById('ws-badge').innerHTML = health.status === 'ok'
      ? '<span style="color:var(--green)">&#x25CF; \u6B63\u5E38</span>'
      : '<span style="color:var(--red)">&#x25CF; \u7570\u5E38</span>';
    document.getElementById('ws-body').innerHTML =
      row('\u5F8C\u7AEF\u72C0;&#x614B;', health.status==='ok'?'\u904B\u4F5C\u6B63\u5E38':'\u7570\u5E38', wsCls) +
      row('\u6D3B\u8E8D Sessions', (health.activeSessions||0).toLocaleString(), '') +
      row('\u5E33\u865F\u6C60', (health.totalAccounts||0)+' \u500B', 'dim') +
      row('Port', '3000', 'dim');
    document.getElementById('ingest-badge').textContent = (ing.totalPoints||0).toLocaleString() + ' pts';
    document.getElementById('ingest-body').innerHTML =
      row('\u7E3D TrackPoints', (ing.totalPoints||0).toLocaleString(), '') +
      row('\u7E3D\u6279\u6B21', (ing.totalBatches||0).toLocaleString(), '') +
      row('Sessions \u5EFA\u7ACB', (ing.sessionsCreated||0).toLocaleString(), '') +
      row('Sessions \u95DC\u9589', (ing.sessionsClosed||0).toLocaleString(), 'dim');
    document.getElementById('api-badge').textContent = (stats.totalCalls||0).toLocaleString() + ' calls';
    document.getElementById('api-body').innerHTML =
      row('\u7E3D API \u547C\u53EB', (stats.totalCalls||0).toLocaleString(), '') +
      row('State \u547C\u53EB', (stats.stateCalls||0).toLocaleString(), 'dim') +
      row('Metadata \u547C\u53EB', (stats.metadataCalls||0).toLocaleString(), 'dim') +
      row('Cache \u547D\u4E2D', (stats.cacheHits||0).toLocaleString(), 'ok') +
      row('\u932F\u8AA4\u6B21\u6578', (stats.errors||0).toLocaleString(), (stats.errors||0)>0?'err':'dim');
    if (lastCycle !== null && ing.totalBatches !== lastCycle) {
      var el = document.getElementById('sync-badge');
      el.style.background = 'rgba(16,185,129,.3)';
      el.style.color = '#10b981';
      setTimeout(function(){ el.style.background=''; el.style.color=''; }, 700);
    }
    lastCycle = ing.totalBatches;
  } catch(err) {
    document.getElementById('sync-dot').style.background = '#ef4444';
    document.getElementById('sync-label').textContent = '\u9023\u7DDA\u5931\u6557';
  }
}
refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
}

// 健康檢查
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        cacheSize: masterStateMap?.size ?? globalPlanesCache.states?.length ?? 0,
        activeAccount: accountPool.getCurrentUser(),
        totalAccounts: _rawAccounts.length,
        activeSessions: activeSessions.size,
        ingestion: ingestionStats,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/ingestion/status', async (req, res) => {
    let trackPointCount = null;
    let sessionCount = null;
    try {
        if (true) {  // store always ready
            trackPointCount = await TrackPoint.estimatedDocumentCount();
            sessionCount = await FlightSession.estimatedDocumentCount();
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
    errors: 0,
    lastError: null,
    lastErrorTime: null,
    lastSuccessTime: null,
    startTime: Date.now(),
    // accounts 動態從 pool 讀取，不再在此儲存
    get accounts() { return accountPool.getStats(); },
};

app.get('/api/stats', function (req, res) {
    res.json({
        totalCalls: apiStats.totalCalls,
        stateCalls: apiStats.stateCalls,
        metadataCalls: apiStats.metadataCalls,
        cacheHits: apiStats.cacheHits,
        accounts: accountPool.getStats(),
        errors: apiStats.errors,
        lastError: apiStats.lastError,
        lastErrorTime: apiStats.lastErrorTime,
        lastSuccessTime: apiStats.lastSuccessTime,
        uptimeMinutes: Math.round((Date.now() - apiStats.startTime) / 60000),
        recommendedInterval: Math.round(accountPool.getRecommendedInterval(15000) / 1000),
        activeAccount: accountPool.getCurrentUser(),
        // [v11.0] Per-source health for DevPanel
        sourceHealth,
        totalPlanes: masterStateMap?.size ?? globalPlanesCache.states?.length ?? 0,
    });
});

// calculateRecommendedInterval 委派給 accountPool（保留名稱供舊呼叫點使用）
function calculateRecommendedInterval() {
    return Math.round(accountPool.getRecommendedInterval(15000) / 1000);
}

// ==========================================
// [v11.0] Multi-Source Polling Engine — Shared State
// ==========================================
let globalPlanesCache = { states: [], time: 0 };
let lastGlobalStatesMap = new Map(); // icao24 -> state (用於偵測起飛/降落)

// ── Master state map with TTL ──────────────────────────────────────────────
// All three tiers write here. pruneAndBroadcast() serialises to globalPlanesCache.
const masterStateMap = new Map();  // icao24 → { ...state, _lastSeen: ms }
const PLANE_TTL_MS = 90_000;       // 90s without update → remove from map

// ── Centralised circuit breakers & source health ──────────────────────────
const sourceHealth = {};  // key → { cbUntil, consecutiveFails, lastOk, lastCount, lastLatency }
const SOURCE_CB_MS = 5 * 60_000;  // 5 min backoff on 429/503
const cbOpen  = k => (sourceHealth[k]?.cbUntil || 0) > Date.now();
const cbTrip  = (k, ms = SOURCE_CB_MS) => {
    sourceHealth[k] = {
        ...sourceHealth[k],
        cbUntil: Date.now() + ms,
        consecutiveFails: (sourceHealth[k]?.consecutiveFails || 0) + 1,
    };
};
const cbReset = (k, count, latency) => {
    sourceHealth[k] = { cbUntil: 0, consecutiveFails: 0, lastOk: Date.now(), lastCount: count, lastLatency: latency };
};

// ── Merge helper ───────────────────────────────────────────────────────────
// strategy='upsert': full replacement (Tier 1 global baseline)
// strategy='merge' : keep existing fields, only update non-null new values (Tier 2/3 overlays)
function mergeStates(states, strategy = 'upsert') {
    const now = Date.now();
    for (const p of states) {
        if (!p.icao24 || typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
        if (strategy === 'merge') {
            const existing = masterStateMap.get(p.icao24) || {};
            const merged = { ...existing, ...p, _lastSeen: now };
            // Preserve richer metadata fields from existing if new record lacks them
            if (!p.description && existing.description) merged.description = existing.description;
            if (!p.year        && existing.year)        merged.year        = existing.year;
            if (!p.typecode    && existing.typecode)    merged.typecode    = existing.typecode;
            masterStateMap.set(p.icao24, merged);
        } else {
            masterStateMap.set(p.icao24, { ...p, _lastSeen: now });
        }
    }
}

// ── Prune stale planes + serialise to cache + broadcast ───────────────────
function pruneAndBroadcast() {
    const cutoff = Date.now() - PLANE_TTL_MS;
    for (const [id, p] of masterStateMap) {
        if ((p._lastSeen || 0) < cutoff) masterStateMap.delete(id);
    }
    const states = Array.from(masterStateMap.values());
    globalPlanesCache = { states, time: Math.floor(Date.now() / 1000), stale: false };
    broadcastPlanes(states, globalPlanesCache.time);
}

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
    const { headers, account } = await accountPool.getHeaders();
    let url = 'https://opensky-network.org/api/states/all';

    // 構建 BBox 語法
    if (params.lamin !== undefined) {
        url += `?lamin=${params.lamin}&lomin=${params.lomin}&lamax=${params.lamax}&lomax=${params.lomax}`;
    }

    const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30000)
    });

    accountPool.recordResponse(account, response.status, response.headers);
    apiStats.totalCalls++;

    if (!response.ok) {
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
 * [v10.3] Shared normalizer for all adsb-format sources (adsb.lol, adsb.fi, airplanes.live).
 * All three return the same ADSBexchange v2 compatible format with `ac[]` array.
 * Extra fields (desc, ownOp, year, nav_modes) are passed through for DB write-back.
 */
function normalizeAcRecord(p) {
    return {
        icao24:      p.hex?.toLowerCase(),
        callsign:    (p.flight || '').trim(),
        lng:         p.lon,
        lat:         p.lat,
        altitude:    p.alt_baro === 'ground' ? 0 : (p.alt_baro || p.alt_geom || 0),
        velocity:    (p.gs || 0) * 0.51444,
        heading:     p.track || 0,
        vRate:       (p.baro_rate || 0) * 0.00508,
        onGround:    p.alt_baro === 'ground' || false,
        squawk:      p.squawk || null,
        typecode:    p.t || p.type || null,
        registration: p.r || null,
        operator:    p.ownOp || null,
        description: p.desc || null,
        year:        p.year || null,
        navModes:    p.nav_modes || null,
        category:    p.category || null,
        isMil:       !!(p.mil || p.dbFlags === 1),
    };
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
    // API returns ac[] (ADSBexchange v2 format), not aircraft[]
    const standardStates = (data.ac || []).map(p => normalizeAcRecord(p))
        .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');

    return { states: standardStates, time: Math.floor(data.now || Date.now() / 1000) };
}

/**
 * adsb.fi open data API — ADSBexchange v2 compatible, no auth required.
 * Public rate limit: 1 req/sec. Used as fallback when Airplanes.Live fails.
 */
async function fetchAdsbFi(lat, lon, dist = 250) {
    const response = await fetch(
        `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`,
        { headers: { 'User-Agent': 'AEROSTRAT/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) throw new Error(`adsb.fi Error: ${response.status}`);
    const data = await response.json();
    // API returns ac[] (ADSBexchange v2 format), not aircraft[]
    const standardStates = (data.ac || []).map(p => normalizeAcRecord(p))
        .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
    return { states: standardStates };
}

/**
 * [Time Series] Helper to ingest raw plane data into MongoDB
 * Standardizes format, lowercases ICAO24, and filters out corrupted coordinates.
 */
// [v6.0] Ingestion telemetry counters
const ingestionStats = { totalPoints: 0, totalBatches: 0, sessionsCreated: 0, sessionsClosed: 0, lastBatchSize: 0, lastBatchMs: 0 };

async function ingestTrackPoints(states, timeUnix) {
    if (!states || states.length === 0) return;

    if (false) {  // store always ready
        console.warn('[DATABASE] Skip ingestion: MongoDB not connected.');
        return;
    }

    const timestamp = new Date(timeUnix * 1000);
    const now = Date.now();
    const batchTrackPoints = [];
    const sessionCloseOps = [];   // Batched session close operations
    const sessionCreateDocs = []; // Batched new session documents

    // ── Session thresholds (defined once outside the hot loop) ─────────
    const SESSION_TIMEOUT_MS = 600000;      // 10 minutes (reduced from 20 to free activeSessions memory sooner)
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

        // ── Meaningful-change filter (tar1090-style deduplication) ───────────
        // Only store a new point when position or state has changed significantly.
        // Rules (mirrors tar1090): skip if NONE of these changed since last store:
        //   - lat/lng differ (any movement)
        //   - altitude changed > 60m (~200ft)
        //   - heading changed > 5°
        //   - velocity changed > 5 m/s (~10 kts)
        //   - time since last stored > 60 seconds (heartbeat guarantee)
        const lsp = lastStoredPoint.get(icao24);
        if (lsp) {
            // Use L1-norm distance threshold (~55m) instead of exact equality.
            // ADS-B parked aircraft have sub-50m transponder jitter that would
            // pass an exact-equality check and trigger unnecessary writes every 15s.
            const MIN_POS_DEG = 0.0005; // ~55m — below any meaningful flight-phase delta
            const samePos     = Math.abs(p.lat - lsp.lat) + Math.abs(p.lng - lsp.lng) < MIN_POS_DEG;
            const altDelta    = Math.abs((p.altitude || 0) - lsp.altitude);
            const hdgDelta    = Math.min(Math.abs((p.heading || 0) - lsp.heading), 360 - Math.abs((p.heading || 0) - lsp.heading));
            const spdDelta    = Math.abs((p.velocity || 0) - lsp.velocity);
            const timeDelta   = timeUnix - lsp.ts;
            const meaningful  = !samePos || altDelta > 60 || hdgDelta > 5 || spdDelta > 5 || timeDelta > 60;
            if (!meaningful) continue;
        }
        lastStoredPoint.set(icao24, {
            lat: p.lat, lng: p.lng,
            altitude: p.altitude || 0,
            heading: p.heading || 0,
            velocity: p.velocity || 0,
            ts: timeUnix
        });

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

// ── v11.0 Three-Tier Polling Engine ───────────────────────────────────────
// Replaces the old single-loop fetchGlobalPlanes().
// Three independent setIntervals run concurrently:
//   fetchGlobalBaseline    — 15s  parallel adsb.fi-snap + adsb.lol
//   fetchViewportOverlay   — 8s   parallel AL-point + re-api, fallback adsb.fi v3
//   fetchSpecialCategories — 60s  parallel AL-mil + AL-ladd

// ── Tier 1: Global Baseline ────────────────────────────────────────────────
let _baselineRunning = false;
async function fetchGlobalBaseline() {
    if (_baselineRunning) return;
    _baselineRunning = true;
    const t0 = performance.now();

    try {
        const [snapR, lolR] = await Promise.allSettled([
            cbOpen('adsb.fi-snap')
                ? Promise.reject(new Error('CB open'))
                : fetch('https://opendata.adsb.fi/api/v2/snapshot', {
                      headers: { 'User-Agent': 'AEROSTRAT/11.0' },
                      signal: AbortSignal.timeout(12000),
                  }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),

            cbOpen('adsb.lol')
                ? Promise.reject(new Error('CB open'))
                : fetch('https://api.adsb.lol/v2/lat/0/lon/0/dist/99999', {
                      headers: { 'User-Agent': 'AEROSTRAT/11.0' },
                      signal: AbortSignal.timeout(10000),
                  }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
        ]);

        let snapStates = [];
        let lolStates  = [];

        if (snapR.status === 'fulfilled') {
            snapStates = (snapR.value.ac || []).map(p => normalizeAcRecord(p))
                .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
            cbReset('adsb.fi-snap', snapStates.length, Math.round(performance.now() - t0));
        } else {
            const msg = snapR.reason?.message || '';
            if (msg.includes('429') || msg.includes('403')) cbTrip('adsb.fi-snap');
        }

        if (lolR.status === 'fulfilled') {
            lolStates = (lolR.value.ac || []).map(p => normalizeAcRecord(p))
                .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
            cbReset('adsb.lol', lolStates.length, Math.round(performance.now() - t0));
        } else {
            const msg = lolR.reason?.message || '';
            if (msg.includes('429') || msg.includes('503')) cbTrip('adsb.lol');
        }

        if (snapStates.length === 0 && lolStates.length === 0) {
            logger.warn('SYNC', 'Global baseline: both sources failed — using stale cache');
            globalPlanesCache.stale = true;
            return;
        }

        // Use the richer set as the base; merge the other's metadata fields
        let baseStates, extraStates;
        if (snapStates.length >= lolStates.length) {
            [baseStates, extraStates] = [snapStates, lolStates];
        } else {
            [baseStates, extraStates] = [lolStates, snapStates];
        }

        // Build extra map for metadata-only merge (desc, year, typecode)
        if (extraStates.length > 0) {
            const extraMap = new Map(extraStates.map(p => [p.icao24, p]));
            for (const p of baseStates) {
                const ex = extraMap.get(p.icao24);
                if (!ex) continue;
                if (!p.description && ex.description) p.description = ex.description;
                if (!p.year        && ex.year)        p.year        = ex.year;
                if (!p.typecode    && ex.typecode)    p.typecode    = ex.typecode;
            }
        }

        mergeStates(baseStates, 'upsert');
        pruneAndBroadcast();

        const sourceStr = [snapStates.length > 0 && 'adsb.fi-snap', lolStates.length > 0 && 'adsb.lol']
            .filter(Boolean).join('+');
        logger.info('SYNC', `✅ Global baseline: ${baseStates.length} planes | sources: ${sourceStr} | ${Math.round(performance.now()-t0)}ms`);

        // Metadata enrichment + TrackPoint ingestion (only on global cycle, not viewport)
        await enrichAndIngest();

    } catch (e) {
        logger.error('SYNC', `Global baseline error: ${e.message}`);
        globalPlanesCache.stale = true;
    } finally {
        _baselineRunning = false;
    }
}

// ── Tier 2: Viewport Overlay ───────────────────────────────────────────────
let _viewportRunning = false;
async function fetchViewportOverlay() {
    if (_viewportRunning) return;
    _viewportRunning = true;
    const t0 = performance.now();

    try {
        const viewports = getActiveViewports();
        const vp = viewports.length > 0 ? viewports[0] : null;
        if (!vp) return; // No active clients — skip viewport fetch to save bandwidth & CPU
        const lat = ((vp.lamin + vp.lamax) / 2).toFixed(4);
        const lon = ((vp.lomin + vp.lomax) / 2).toFixed(4);

        // Parallel: airplanes.live /point + re-api
        const [alR, reR] = await Promise.allSettled([
            cbOpen('al-point')
                ? Promise.reject(new Error('CB open'))
                : fetch(`https://api.airplanes.live/v2/point/${lat}/${lon}/250`, {
                      headers: { 'User-Agent': 'AEROSTRAT/11.0' },
                      signal: AbortSignal.timeout(8000),
                  }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),

            cbOpen('re-api')
                ? Promise.reject(new Error('CB open'))
                : fetch(`https://re-api.adsb.lol?circle=${lat},${lon},500`, {
                      headers: { 'User-Agent': 'AEROSTRAT/11.0' },
                      signal: AbortSignal.timeout(8000),
                  }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
        ]);

        let vpStates = [];
        let vpSources = [];

        if (alR.status === 'fulfilled') {
            const states = (alR.value.ac || []).map(p => normalizeAcRecord(p))
                .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
            vpStates = vpStates.concat(states);
            vpSources.push('al-point');
            cbReset('al-point', states.length, Math.round(performance.now() - t0));
        } else {
            const msg = alR.reason?.message || '';
            if (msg.includes('429')) cbTrip('al-point');
        }

        if (reR.status === 'fulfilled') {
            // re-api uses "aircraft" key (readsb native)
            const states = (reR.value.aircraft || []).map(p => normalizeAcRecord(p))
                .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
            vpStates = vpStates.concat(states);
            vpSources.push('re-api');
            cbReset('re-api', states.length, Math.round(performance.now() - t0));
        } else {
            const msg = reR.reason?.message || '';
            if (msg.includes('429') || msg.includes('403')) cbTrip('re-api');
        }

        // Fallback: adsb.fi v3 if both AL and re-api failed
        if (vpStates.length === 0 && !cbOpen('adsb.fi-v3')) {
            try {
                const r = await fetch(
                    `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/250`,
                    { headers: { 'User-Agent': 'AEROSTRAT/11.0' }, signal: AbortSignal.timeout(8000) }
                );
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const data = await r.json();
                vpStates = (data.ac || []).map(p => normalizeAcRecord(p))
                    .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
                vpSources.push('adsb.fi-v3');
                cbReset('adsb.fi-v3', vpStates.length, Math.round(performance.now() - t0));
            } catch (e) {
                if (e.message.includes('429')) cbTrip('adsb.fi-v3');
            }
        }

        if (vpStates.length > 0) {
            mergeStates(vpStates, 'merge');  // merge: preserve existing desc/year/typecode
            pruneAndBroadcast();
            logger.debug('SYNC', `Viewport overlay: ${vpStates.length} planes | sources: ${vpSources.join('+')} | ${Math.round(performance.now()-t0)}ms`);
        }
    } catch (e) {
        logger.error('SYNC', `Viewport overlay error: ${e.message}`);
    } finally {
        _viewportRunning = false;
    }
}

// ── Tier 3: Special Categories ─────────────────────────────────────────────
let _specialRunning = false;
async function fetchSpecialCategories() {
    if (_specialRunning) return;
    _specialRunning = true;
    const t0 = performance.now();

    try {
        const [milR, laddR] = await Promise.allSettled([
            cbOpen('al-mil')
                ? Promise.reject(new Error('CB open'))
                : fetch('https://api.airplanes.live/v2/mil', {
                      headers: { 'User-Agent': 'AEROSTRAT/11.0' },
                      signal: AbortSignal.timeout(10000),
                  }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),

            cbOpen('al-ladd')
                ? Promise.reject(new Error('CB open'))
                : fetch('https://api.airplanes.live/v2/ladd', {
                      headers: { 'User-Agent': 'AEROSTRAT/11.0' },
                      signal: AbortSignal.timeout(10000),
                  }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
        ]);

        let addedCount = 0;
        const labels = [];

        for (const [result, key, label] of [[milR, 'al-mil', 'mil'], [laddR, 'al-ladd', 'ladd']]) {
            if (result.status === 'fulfilled') {
                const states = (result.value.ac || []).map(p => normalizeAcRecord(p))
                    .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
                mergeStates(states, 'merge');
                addedCount += states.length;
                labels.push(`${label}:${states.length}`);
                cbReset(key, states.length, Math.round(performance.now() - t0));
            } else {
                const msg = result.reason?.message || '';
                if (msg.includes('429')) cbTrip(key);
            }
        }

        if (addedCount > 0) {
            pruneAndBroadcast();
            logger.info('SYNC', `Special categories: ${addedCount} planes | ${labels.join(', ')} | ${Math.round(performance.now()-t0)}ms`);
        }
    } catch (e) {
        logger.error('SYNC', `Special categories error: ${e.message}`);
    } finally {
        _specialRunning = false;
    }
}

// ── Enrichment + TrackPoint ingestion (called after global baseline) ───────
let _enrichRunning = false;
// [perf] Per-icao24 cooldown: skip Aircraft upsert if written < 5 min ago and no clients
const _aircraftWriteCooldown = new Map(); // icao24 → last write timestamp (ms)
async function enrichAndIngest() {
    if (_enrichRunning) return;
    _enrichRunning = true;
    const finalStates = Array.from(masterStateMap.values());

    try {
        // Phase 1: Write-back enriched fields to Aircraft DB
        // [perf] Only upsert if: (a) has clients watching, OR (b) this icao24 hasn't been written in 5 min
        const hasClients = getClientCount() > 0;
        const now = Date.now();
        const WRITE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
        const writebackOps = finalStates
            .filter(p => {
                if (!(p.registration || p.operator || p.typecode || p.description)) return false;
                const lastWrite = _aircraftWriteCooldown.get(p.icao24) || 0;
                if (!hasClients && now - lastWrite < WRITE_COOLDOWN_MS) return false;
                _aircraftWriteCooldown.set(p.icao24, now);
                return true;
            })
            .map(p => ({
                updateOne: {
                    filter: { $or: [{ icao24: p.icao24 }, { hex: p.icao24 }] },
                    update: {
                        $set: Object.fromEntries([
                            ['icao24', p.icao24], ['hex', p.icao24],
                            p.registration && ['registration', p.registration],
                            p.typecode     && ['typecode',      p.typecode],
                            p.typecode     && ['type_code',     p.typecode],
                            p.operator     && ['operator',      p.operator],
                            p.operator     && ['airline',       p.operator],
                            p.description  && ['description',   p.description],
                            p.year         && ['year',          p.year],
                        ].filter(Boolean)),
                    },
                    upsert: true,
                },
            }));
        if (writebackOps.length > 0) Aircraft.bulkWrite(writebackOps, { ordered: false }).catch(() => null);

        // Phase 2: Fill missing typecode from Aircraft DB
        const icaoList = finalStates.map(p => p.icao24);
        const [dbMeta, dbReg] = await Promise.all([
            Aircraft.find({ icao24: { $in: icaoList } }, { icao24: 1, typecode: 1 }),
            Aircraft.find(
                { icao24: { $in: finalStates.filter(p => !p.registration).map(p => p.icao24) } },
                { icao24: 1, registration: 1, owner: 1, operatorCallsign: 1 }
            ),
        ]);
        const metaMap = new Map(dbMeta.map(m => [m.icao24.toLowerCase(), m.typecode]));
        const regMap  = new Map(dbReg.map(r => [r.icao24.toLowerCase(), r]));

        let enrichedCount = 0;
        finalStates.forEach(p => {
            const k = p.icao24.toLowerCase();
            let tc = p.typecode || metaMap.get(k);
            if (!tc && aircraftMetadataIndex?.has(k)) {
                tc = aircraftMetadataIndex.get(k);
                if (p.callsign && p.callsign !== 'UNKNOWN') triggerBackgroundResolution(k, p.callsign);
            }
            if (tc) { p.typecode = tc; enrichedCount++; }
            const reg = regMap.get(k);
            if (reg) {
                if (!p.registration && reg.registration) p.registration = reg.registration;
                if (!p.operator && (reg.owner || reg.operatorCallsign))
                    p.operator = reg.owner || reg.operatorCallsign;
            }
        });

        // Phase 3: Ingest TrackPoints
        await ingestTrackPoints(finalStates, Math.floor(Date.now() / 1000));

        if (ingestionStats.totalBatches % 10 === 0 && ingestionStats.totalBatches > 0) {
            logger.info('INGEST', `Cumulative: ${ingestionStats.totalPoints.toLocaleString()} pts | ${ingestionStats.totalBatches} batches | sessions: ${activeSessions.size} active`);
        }

    } catch (e) {
        logger.warn('SYNC', `enrichAndIngest error: ${e.message}`);
    } finally {
        _enrichRunning = false;
    }
}

// ── OBSOLETE — kept as dead reference only, replaced by three-tier engine ──
// The original monolithic fetchGlobalPlanes() used a single 10s setInterval
// with phase A/B/C sequential execution. This caused 3-5s total latency per
// cycle and wasted OpenSky quota on live tracking. Replaced by v11.0 above.
async function fetchGlobalPlanes() {
    if (isFetchingGlobal) return;
    isFetchingGlobal = true;
    const start = performance.now();
    syncCycleCount++;
    // OpenSky every 45s (every 4-5th cycle of 10s) = ~1920 calls/day.
    // [v10.3] Global cycle every 2nd tick (20s) — adsb.lol/adsb.fi have no hard daily quota.
    // adsb.fi snapshot (feeder IP): ~6260 ac global. adsb.lol fallback: ~5270 ac global.
    const isGlobalCycle = syncCycleCount % 2 === 0 || lastOpenSkyFetchTime === 0; // ~every 20s
    logger.debug('SYNC', `Cycle #${syncCycleCount} started | cached: ${(globalPlanesCache.states || []).length} planes`);

    try {
        let mergedStates = [];
        let sourceTags = [];
        const now = Date.now();

        // ── Phase A: GLOBAL BASELINE (every ~50s) ─────────────────────
        if (isGlobalCycle) {
            let gotGlobal = false;

            // [v10.3] Priority 1: adsb.fi snapshot (feeder IP, ~6260 ac global, best coverage)
            // Falls through to adsb.lol if unavailable (non-feeder IP or network change)
            try {
                const snapRes = await fetch('https://opendata.adsb.fi/api/v2/snapshot', {
                    headers: { 'User-Agent': 'AEROSTRAT/10.3' },
                    signal: AbortSignal.timeout(10000)
                });
                if (snapRes.ok) {
                    const data = await snapRes.json();
                    mergedStates = (data.ac || []).map(p => normalizeAcRecord(p));
                    lastOpenSkyFetchTime = now;
                    sourceTags.push('adsb.fi-snap');
                    gotGlobal = true;
                    logger.info('SYNC', `adsb.fi snapshot OK — ${mergedStates.length} planes | ${Math.round(performance.now() - start)}ms`);
                }
            } catch (_) { /* fall through */ }

            // [v10.3] Priority 2: adsb.lol global — no quota, ~5270 ac, safe at 1/s
            // Fixed URL: /v2/all was 404; correct is /v2/lat/0/lon/0/dist/99999
            if (!gotGlobal) {
                try {
                    const res = await fetch('https://api.adsb.lol/v2/lat/0/lon/0/dist/99999', {
                        headers: { 'User-Agent': 'AEROSTRAT/10.3' },
                        signal: AbortSignal.timeout(8000)
                    });
                    if (res.ok) {
                        const data = await res.json();
                        mergedStates = (data.ac || []).map(p => normalizeAcRecord(p));
                        lastOpenSkyFetchTime = now;
                        sourceTags.push('adsb.lol');
                        gotGlobal = true;
                        logger.info('SYNC', `adsb.lol global OK — ${mergedStates.length} planes | ${Math.round(performance.now() - start)}ms`);
                    }
                } catch (_) { /* fall through to OpenSky */ }
            }

            // OpenSky — primary global source, always tried when adsb.lol is unavailable
            // Circuit breaker: 429/503 → 5 分鐘 backoff，避免持續轟炸已過載的伺服器
            if (!fetchGlobalPlanes._osCbUntil) fetchGlobalPlanes._osCbUntil = 0;
            const osCircuitOpen = Date.now() < fetchGlobalPlanes._osCbUntil;

            if (!gotGlobal && !osCircuitOpen) {
                try {
                    const osData = await fetchOpenSky();
                    mergedStates = osData.states;
                    lastOpenSkyFetchTime = now;
                    sourceTags.push('OpenSky');
                    gotGlobal = true;
                    fetchGlobalPlanes._osCbUntil = 0; // 成功則重置
                    logger.info('SYNC', `OpenSky fetch OK — ${mergedStates.length} planes | ${Math.round(performance.now() - start)}ms`);
                } catch (osErr) {
                    if (osErr.message.includes('429') || osErr.message.includes('503')) {
                        fetchGlobalPlanes._osCbUntil = Date.now() + 5 * 60 * 1000;
                        logger.warn('SYNC', `OpenSky CB tripped (${osErr.message}) — backoff 5min`);
                    } else {
                        logger.warn('SYNC', `OpenSky failed (${osErr.message}) — keeping stale baseline`);
                    }
                }
            } else if (!gotGlobal && osCircuitOpen) {
                logger.debug('SYNC', `OpenSky CB open — skipping (retry at ${new Date(fetchGlobalPlanes._osCbUntil).toISOString()})`);
            }

            if (!gotGlobal) {
                mergedStates = globalPlanesCache.states || [];
                sourceTags.push('Cache');
            }
        } else {
            mergedStates = [...(globalPlanesCache.states || [])];
            sourceTags.push('Cache');
        }

        // ── [OBSOLETE BODY — replaced by v11.0 three-tier engine] ──────────
        const stateMap = new Map(mergedStates.map(p => [p.icao24, p]));
        const CB_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
        if (!fetchGlobalPlanes._cb) fetchGlobalPlanes._cb = {};
        const cb = fetchGlobalPlanes._cb;
        const cbOpen = (key) => cb[key] && (Date.now() - cb[key] < CB_BACKOFF_MS);
        const cbTrip = (key) => { cb[key] = Date.now(); };

        // 1. Airplanes.Live Military Feed
        if (!cbOpen('al_mil')) {
            try {
                const milData = await fetchAirplanesLive('mil');
                milData.states.forEach(p => stateMap.set(p.icao24, p));
                sourceTags.push('AL-Mil');
                delete cb['al_mil']; // reset on success
            } catch (milErr) {
                if (milErr.message.includes('429') || milErr.message.includes('503')) cbTrip('al_mil');
                logger.warn('SYNC', `AL-Mil failed: ${milErr.message}`);
            }
        }

        // 2. Viewport / Home point query — only 1 viewport to halve request rate
        const viewports = getActiveViewports();
        const vp = viewports.length > 0 ? viewports[0] : null;
        const centerLat = vp ? (vp.lamin + vp.lamax) / 2 : 25.07;
        const centerLon = vp ? (vp.lomin + vp.lomax) / 2 : 121.23;
        const pointLabel = vp ? 'AL-Point' : 'AL-Home';
        const cbKeyAL = vp ? 'al_point' : 'al_home';
        const cbKeyFi = vp ? 'fi_point' : 'fi_home';

        if (!cbOpen(cbKeyAL)) {
            try {
                const regional = await fetchAirplanesLive('point', { lat: centerLat, lon: centerLon, dist: 250 });
                regional.states.forEach(p => stateMap.set(p.icao24, p));
                sourceTags.push(`${pointLabel}(${centerLat.toFixed(1)})`);
                delete cb[cbKeyAL];
                delete cb[cbKeyFi]; // AL back → adsb.fi circuit also reset
            } catch (regErr) {
                if (regErr.message.includes('429') || regErr.message.includes('503')) cbTrip(cbKeyAL);
                if (!cbOpen(cbKeyFi)) {
                    try {
                        const regional = await fetchAdsbFi(centerLat, centerLon, 250);
                        regional.states.forEach(p => stateMap.set(p.icao24, p));
                        sourceTags.push(`ADSBFI(${centerLat.toFixed(1)})`);
                        delete cb[cbKeyFi];
                    } catch (fiErr) {
                        if (fiErr.message.includes('429') || fiErr.message.includes('503')) cbTrip(cbKeyFi);
                    }
                }
            }
        }

        // 3. [v10.3] re-api.adsb.lol — feeder IP viewport overlay (uses "aircraft" key, not "ac")
        if (!cbOpen('re_api')) {
            try {
                const reUrl = `https://re-api.adsb.lol?circle=${centerLat.toFixed(2)},${centerLon.toFixed(2)},500`;
                const reRes = await fetch(reUrl, {
                    headers: { 'User-Agent': 'AEROSTRAT/10.3' },
                    signal: AbortSignal.timeout(8000)
                });
                if (reRes.ok) {
                    const reData = await reRes.json();
                    // re-api uses "aircraft" key (readsb native format)
                    (reData.aircraft || [])
                        .map(p => normalizeAcRecord(p))
                        .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number')
                        .forEach(p => stateMap.set(p.icao24, { ...stateMap.get(p.icao24), ...p }));
                    sourceTags.push('re-api');
                    delete cb['re_api'];
                }
            } catch (reErr) {
                if (reErr.message.includes('429') || reErr.message.includes('403')) cbTrip('re_api');
            }
        }

        const finalStates = Array.from(stateMap.values());
        const fetchLatency = Math.round(performance.now() - start);
        logger.debug('SYNC', `Merge complete — ${finalStates.length} total planes | fetch: ${fetchLatency}ms`);

        // ── Phase C: Metadata Enrichment ──────────────────────────────
        // Write-back: states from Airplanes.Live / adsb.fi / adsb.lol carry
        // registration, operator, description, year. Persist to Aircraft DB in bulk.
        const enrichWriteback = finalStates.filter(p => p.registration || p.operator || p.typecode || p.description);
        if (enrichWriteback.length > 0) {
            const writebackOps = enrichWriteback.map(p => ({
                updateOne: {
                    filter: { $or: [{ icao24: p.icao24 }, { hex: p.icao24 }] },
                    update: {
                        $set: Object.fromEntries([
                            ['icao24', p.icao24], ['hex', p.icao24],
                            p.registration && ['registration', p.registration],
                            p.typecode     && ['typecode', p.typecode],
                            p.typecode     && ['type_code', p.typecode],
                            p.operator     && ['operator', p.operator],
                            p.operator     && ['airline', p.operator],
                            p.description  && ['description', p.description],
                            p.year         && ['year', p.year],
                        ].filter(Boolean))
                    },
                    upsert: true
                }
            }));
            Aircraft.bulkWrite(writebackOps, { ordered: false }).catch(() => null);
        }

        let enrichedCount = 0;
        try {
            const icaoList = finalStates.map(p => p.icao24);

            // ── Typecode enrichment (Aircraft collection) ─────────────────
            const metadata = await Aircraft.find({ icao24: { $in: icaoList } }, { icao24: 1, typecode: 1 });
            const metaMap = new Map(metadata.map(m => [m.icao24.toLowerCase(), m.typecode]));

            // ── Registration + Owner enrichment (Aircraft collection, 532k entries) ─
            // Only fetch planes missing registration to minimise DB load.
            const needsRegIcaos = finalStates.filter(p => !p.registration).map(p => p.icao24);
            let regMap = new Map();
            if (needsRegIcaos.length > 0) {
                const regData = await Aircraft.find(
                    { icao24: { $in: needsRegIcaos } },
                    { icao24: 1, registration: 1, owner: 1, operatorCallsign: 1 }
                );
                regMap = new Map(regData.map(r => [r.icao24.toLowerCase(), r]));
            }

            finalStates.forEach(p => {
                const lowerIcao = p.icao24.toLowerCase();

                // Typecode
                let tc = p.typecode || metaMap.get(lowerIcao);
                if (!tc && aircraftMetadataIndex.has(lowerIcao)) {
                    tc = aircraftMetadataIndex.get(lowerIcao);
                    if (p.callsign && p.callsign !== 'UNKNOWN') {
                        triggerBackgroundResolution(lowerIcao, p.callsign);
                    }
                }
                if (tc) { p.typecode = tc; enrichedCount++; }

                // Registration + Airline from Aircraft collection
                const reg = regMap.get(lowerIcao);
                if (reg) {
                    if (!p.registration && reg.registration) p.registration = reg.registration;
                    if (!p.operator   && (reg.owner || reg.operatorCallsign))
                        p.operator = reg.owner || reg.operatorCallsign;
                }
            });
        } catch (dbErr) {
            logger.warn('METADATA', `Enrichment failed: ${dbErr.message}`);
        }

        // [OBSOLETE] This path is never reached in v11.0
        logger.warn('SYNC', 'fetchGlobalPlanes() body reached — should not happen in v11.0');
    } catch (e) {
        logger.error('SYNC', `fetchGlobalPlanes (obsolete) error: ${e.message}`);
    }
}

// ── [v11.0] Three-Tier Engine Startup ─────────────────────────────────────
setInterval(fetchGlobalBaseline,    25_000);   // full global refresh (was 15s, reduced to save CPU)
setInterval(fetchViewportOverlay,   12_000);   // viewport high-frequency (was 8s)
setInterval(fetchSpecialCategories, 60_000);   // military + LADD (slow)

// [v7.0] Session timeout reaper — in-memory cleanup every 5 minutes
setInterval(() => {
    const now = Date.now();
    const staleThreshold = 1200000; // 20 minutes
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
}, 300000);

// [v11.0] DB-level stale session reaper — bulk-closes ACTIVE sessions >2h old in DB.
// Runs every 30 minutes. Handles sessions that accumulated from previous server runs.
const DB_SESSION_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours
async function reapStaleDbSessions() {
    
    try {
        const cutoff = new Date(Date.now() - DB_SESSION_STALE_MS);
        const result = await FlightSession.updateMany(
            { status: 'ACTIVE', updatedAt: { $lt: cutoff } },
            { $set: { status: 'TIMEOUT', endTime: cutoff } }
        );
        if (result.modifiedCount > 0)
            logger.info('SESSION', `DB reaper: closed ${result.modifiedCount} stale ACTIVE sessions`);
    } catch (e) {
        logger.warn('SESSION', `DB reaper error: ${e.message}`);
    }
}
setInterval(reapStaleDbSessions, 30 * 60 * 1000); // every 30 min
// Run once at startup after DB connects (delayed 10s to let DB init complete)
setTimeout(reapStaleDbSessions, 10_000);

// 啟動時讀取快取並初始化（委派給 AccountPool）
const isFreshQuota = accountPool.loadCache(QUOTA_CACHE_FILE);
(async () => {
    await accountPool.warmup(isFreshQuota);
    // [v11.0] Immediate first-run: global baseline first, then special categories 3s later
    fetchGlobalBaseline();
    setTimeout(fetchSpecialCategories, 3_000);
})();

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

    // 座標範圍驗證（防止異常值進入快取過濾）
    if (isNaN(minLat) || isNaN(minLng) || isNaN(maxLat) || isNaN(maxLng) ||
        minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180 ||
        minLat >= maxLat || minLng >= maxLng) {
        return res.status(400).json({ error: 'Invalid bounding box coordinates' });
    }

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
        // 1. 【快取攔截】：從 masterStateMap 取得即時資料（取代 MongoDB ActiveFlight）
        if (masterStateMap && masterStateMap.size > 0 && globalPlanesCache.time > Date.now() / 1000 - 10) {
            const states = Array.from(masterStateMap.values()).map(p => ({
                hex: p.icao24, callsign: p.callsign,
                lat: p.lat, lon: p.lng, alt: p.altitude, hdg: p.heading, gs: p.velocity
            }));
            return res.json({ source: 'master_state_map', states });
        }

        // 2. 【主線程 (OpenSky)】— 統一走 fetchOpenSky() 避免雙路徑維護
        let standardizedStates = [];
        let sourceUsed = 'opensky';

        try {
            const { states } = await fetchOpenSky({ lamin: 20, lomin: 120, lamax: 26, lomax: 124 });
            standardizedStates = states.map(p => ({
                hex: p.icao24,
                callsign: p.callsign,
                lat: p.lat,
                lon: p.lng,
                alt: p.altitude,
                gs: Math.round((p.velocity || 0) / 0.51444),
                hdg: p.heading
            }));
        } catch (error) {
            // 3. 【備援切換 (ADSB.lol)】
            console.warn(`⚠️ [LIVE PUMP] OpenSky failed (${error.message}). Switching to ADSB.lol...`);
            sourceUsed = 'adsb_lol';
            const fallbackRes = await fetch('https://api.adsb.lol/v2/lat/25.0330/lon/121.5654/dist/250', {
                signal: AbortSignal.timeout(5000)
            });
            if (!fallbackRes.ok) throw new Error(`ADSB.lol failed with status ${fallbackRes.status}`);
            const data = await fallbackRes.json();
            standardizedStates = (data.ac || [])
                .filter(p => p.lat != null && p.lon != null)
                .map(p => ({
                    hex: p.hex,
                    callsign: (p.flight || '').trim(),
                    lat: p.lat,
                    lon: p.lon,
                    alt: p.alt_baro || p.alt_geom || 0,
                    gs: p.gs || 0,
                    hdg: p.track || 0
                }));
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

            // masterStateMap is the authoritative store — no separate DB write needed
        }

        // 5. 回傳最新陣列給前端
        res.json({ source: sourceUsed, states: standardizedStates });

    } catch (err) {
        console.error('❌ [LIVE PUMP ERROR]', err.message);
        res.status(500).json({ error: 'Live data pump failed completely', details: err.message });
    }
});

// ICAO24 hex 格式驗證 helper（6 位十六進位）
function isValidIcao24(hex) {
    return /^[0-9a-f]{6}$/i.test(hex);
}

// 【歷史軌跡補全端點】
app.get('/api/flight-trace/:hex', async (req, res) => {
    const hex = req.params.hex.toLowerCase();
    if (!isValidIcao24(hex)) return res.status(400).json({ error: 'Invalid ICAO24 format' });
    try {
        // 1. 【SQLite TrackPoint 優先】
        const sessionData = activeSessions.get(hex);
        if (sessionData?.sessionId) {
            const pts = await TrackPoint.find({ sessionId: { $in: [sessionData.sessionId] } });
            if (pts.length > 5) {
                const trace = pts.map(p => ({ timestamp: p.timestamp, lat: p.lat, lon: p.lng, alt: p.altitude, hdg: p.heading, gs: p.velocity }));
                return res.json({ hex, source: 'sqlite', trace });
            }
        }

        // 2. 【API 補全 (ADSB.lol)】
        const fallbackRes = await fetch(`https://api.adsb.lol/v2/trace/${hex}`, {
            signal: AbortSignal.timeout(5000)
        });

        if (!fallbackRes.ok) {
            if (fallbackRes.status === 404) return res.json({ hex, source: 'not_found', trace: [] });
            throw new Error(`ADSB.lol trace failed: ${fallbackRes.status}`);
        }

        const data = await fallbackRes.json();
        let backfilledTrace = [];
        if (data.trace && Array.isArray(data.trace)) {
            backfilledTrace = data.trace.map(pt => ({
                timestamp: new Date(pt[0] * 1000),
                lat: pt[1], lon: pt[2], alt: pt[3], hdg: pt[4] || 0, gs: pt[5] || 0
            })).filter(pt => pt.lat != null && pt.lon != null);
        }

        res.json({ hex, source: 'adsb_lol', trace: backfilledTrace });

    } catch (err) {
        console.error(`❌ [TRACE ERROR] ${hex}:`, err.message);
        res.json({ hex, source: 'error_fallback', trace: [], error: err.message });
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
    if (!isValidIcao24(icao24)) return res.status(400).json({ error: 'Invalid ICAO24 format' });

    // 1. 優先檢查靜態字典 (Static First)
    if (aircraftStaticDB[icao24]) {
        return res.json({ ...aircraftStaticDB[icao24], fromStatic: true });
    }

    // [HOTFIX] 連線狀態守衛
    if (false) {  // store always ready
        return res.json({ icao24, noData: true, error: 'Database not connected' });
    }

    try {
        // 2. 檢查 MongoDB 永久快取
        const dbAircraft = await Aircraft.findOne({ icao24 });
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
        const { headers: metaHeaders, account: metaAccount } = await accountPool.getHeaders();
        const response = await fetch(url, {
            headers: metaHeaders,
            signal: AbortSignal.timeout(10000)
        });

        accountPool.recordResponse(metaAccount, response.status, response.headers);

        if (response.status === 404) {
            // 404 = OpenSky 確認無此飛機資料，永久標記避免重複查詢
            await Aircraft.findOneAndUpdate(
                { icao24 },
                { icao24, noData: true, lastUpdated: new Date() },
                { upsert: true }
            );
            logMissingData(icao24, 'metadata');
            return res.json({ icao24, noData: true });
        }
        if (!response.ok) {
            // 429/5xx 為暫時性錯誤，不標記 noData，讓下次請求重試
            return res.json({ icao24, noData: false, error: `OpenSky HTTP ${response.status}` });
        }

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
    if (false) {  // store always ready
        return res.json({ fetched: 0, error: 'Database not connected' });
    }

    // 過濾靜態字典中已有的
    const filteredIcaos = icao24List.filter(id => !aircraftStaticDB[id.toLowerCase()]);
    if (filteredIcaos.length === 0) return res.json({ fetched: 0 });

    try {
        // 從 MongoDB 找出已有的
        const existingInDb = await Aircraft.find({ icao24: { $in: filteredIcaos.map(id => id.toLowerCase()) } });
        const existingIcaos = new Set(existingInDb.map(a => a.icao24));

        const uncached = filteredIcaos.filter(id => !existingIcaos.has(id.toLowerCase()));

        if (uncached.length === 0) {
            return res.json({ fetched: 0, reason: 'all_cached' });
        }

        // [OPT 5.1] 如果所有帳號 quota 均低於安全線，跳過本次批次
        const bestStats = accountPool.getStats().find(a => a.remainingCredits === null || a.remainingCredits > 50);
        if (!bestStats) {
            return res.json({ fetched: 0, skipped: uncached.length, reason: 'quota_low' });
        }

        // 最多同時查詢 10 架
        const toFetch = uncached.slice(0, 10);
        let fetched = 0;

        for (let i = 0; i < toFetch.length; i++) {
            const icao24 = toFetch[i].toLowerCase();
            try {
                const { headers: bHeaders, account: bAccount } = await accountPool.getHeaders();
                apiStats.totalCalls++;
                apiStats.metadataCalls++;
                const response = await fetch(
                    'https://opensky-network.org/api/metadata/aircraft/icao/' + icao24,
                    { headers: bHeaders, signal: AbortSignal.timeout(8000) }
                );

                accountPool.recordResponse(bAccount, response.status, response.headers);

                if (response.status === 429 || response.status >= 500) {
                    // 429 = 配額耗盡；5xx = 伺服器暫時錯誤 — 兩者皆停止批次，不標記 noData
                    break;
                }

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
    if (false) {  // store always ready
        console.warn('⚠️ [GIS] MongoDB not ready, skipping airport cache build.');
        return;
    }
    try {
        // Load from globalAirportsDB (JSON loaded at startup) — same source as before
        const sourceArr = Object.values(globalAirportsDB || {});

        _cachedAirportList = sourceArr.map(a => ({
            icao:    a.icao    || a.ident || '',
            iata:    a.iata    || a.iata_code || '',
            name:    a.name    || '',
            city:    a.city    || a.municipality || '',
            country: a.country || a.iso_country  || '',
            lat:     a.lat     ?? a.latitude_deg  ?? null,
            lng:     a.lng     ?? a.longitude_deg ?? null,
        })).filter(a => a.icao);

        _cachedAirportListETag = 'W/"' + _cachedAirportList.length + '-' + Date.now() + '"';
        if (_cachedAirportList.length === 0)
            console.warn('⚠️ [GIS] Airport cache is empty — run syncOsintData to populate');
        else
            console.log(`✅ [GIS] Airport cache built: ${_cachedAirportList.length} airports.`);
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
        if (true) {  // store always ready
            const dbAirport = await Airport.findOne({
                $or: [{ icao: code }, { iata: code }]
            });
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

        // 4. Check METAR cache (node-cache fallback)
        const metarAirport = await Metar.findOne({ $or: [{ icaoId: code }, { iataId: code }] });
        if (metarAirport) {
            return res.json({
                icao: metarAirport.icaoId, iata: metarAirport.iataId,
                name: metarAirport.name,  city: metarAirport.city,
                country: metarAirport.country, lat: metarAirport.lat,
                lng: metarAirport.lon, source: 'metar_cache'
            });
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
    if (false) {  // store always ready
        return res.status(503).json({ error: 'Database not connected' });
    }
    try {
        const shapes = await AircraftShape.find({}, { _id: 0 });
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
        if (true) {  // store always ready
            const aircraft = await Aircraft.findOne({ icao24: icao24.toLowerCase() });
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
        if (photos.length > 0) {
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
            Aircraft.findOne({ icao24 }),
            AircraftRegistry.findOne({ icao24 }) .catch(() => null)
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
            const updated = await Aircraft.findOneAndUpdate({ icao24 }, metadata, { upsert: true, returnDocument: 'after' });
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

app.get('/api/route/:icao24', async (req, res, next) => {
    // 讓 /api/route/external 通過到下一個路由（Express 依定義順序匹配，external 會先被當成 :icao24）
    if (req.params.icao24 === 'external') return next();
    const icao24 = req.params.icao24.toLowerCase();
    if (!isValidIcao24(icao24)) return res.status(400).json({ error: 'Invalid ICAO24 format' });
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
    if (false) {  // store always ready
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

        // MongoDB cache — skip spatial_inference entries (they are position-guesses, not real routes)
        const dbRoute = await Route.findOne({ callsign: cs });
        if (dbRoute && dbRoute.source !== 'spatial_inference' && dbRoute.departureAirport && dbRoute.arrivalAirport) {
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

    // 2. In-memory short-term cache
    const cached = routeCache.get(icao24);
    if (cached && (Date.now() - cached.timestamp < ROUTE_CACHE_TTL)) {
        return res.json(cached.data);
    }

    try {
        // --- Layer 3: AeroDataBox real-time route lookup ---
        // Must come before spatial inference — provides the actual flight plan, not a position guess.
        if (cleanCallsign) {
            const externalRoute = await fetchRouteData(cleanCallsign);
            if (externalRoute && externalRoute.origin_iata && externalRoute.destination_iata &&
                externalRoute.destination_iata !== '---') {
                console.log(`✅ [AERODATABOX] Route for ${cleanCallsign}: ${externalRoute.origin_iata} → ${externalRoute.destination_iata}`);
                const result = {
                    icao24,
                    callsign: cleanCallsign,
                    departureAirport: externalRoute.origin_iata,
                    arrivalAirport: externalRoute.destination_iata,
                    source: 'aerodatabox'
                };
                routeCache.set(icao24, { data: result, timestamp: Date.now() });
                Route.findOneAndUpdate(
                    { callsign: cleanCallsign },
                    { $set: { departureAirport: externalRoute.origin_iata, arrivalAirport: externalRoute.destination_iata,
                        origin_iata: externalRoute.origin_iata, destination_iata: externalRoute.destination_iata,
                        source: 'aerodatabox', lastUpdated: new Date() } },
                    { upsert: true }
                ).catch(() => null);
                return res.json(result);
            }
        }

        // --- Layer 4: Spatial inference — ONLY for low-altitude aircraft (just departed / about to land) ---
        // Trans-oceanic/en-route aircraft must NOT use this — their first tracked point is mid-ocean.
        const trackData = await fetchTracksInternal(icao24);

        if (trackData && trackData.path && trackData.path.length > 0) {
            const startPoint = trackData.path[0];
            const startAlt = startPoint[3] || 0; // metres barometric altitude

            // Only infer if the first tracked point is below 3000m (≈10,000ft) — aircraft near an airport
            if (startAlt < 3000) {
                const startLat = startPoint[1];
                const startLng = startPoint[2];
                const nearestAp = findNearestAirport(startLat, startLng, 20);

                if (nearestAp) {
                    console.log(`✅ [SPATIAL] Low-altitude inference: ${nearestAp.icao} for ${cleanCallsign} (alt=${startAlt}m)`);
                    const inferredResult = {
                        icao24,
                        callsign: cleanCallsign,
                        departureAirport: nearestAp.icao,
                        arrivalAirport: null,
                        isInferred: true,
                        source: 'spatial_inference'
                    };
                    routeCache.set(icao24, { data: inferredResult, timestamp: Date.now() });
                    // Do NOT persist spatial_inference to MongoDB — avoids poisoning the route cache
                    return res.json(inferredResult);
                }
            } else {
                console.log(`⚠️ [SPATIAL] Skipped for ${cleanCallsign} — first point is at ${startAlt}m (en-route)`);
            }
        }

        console.log(`⚠️ [ROUTE] ${cleanCallsign} not found. Returning noData.`);
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

// Cache for OpenSky historical tracks — longer TTL since data changes slowly mid-flight
const historicalTrackCache = new Map();
const HISTORICAL_TRACK_TTL = 90000; // 90 seconds

/**
 * Fetch historical track for a single aircraft from OpenSky Network.
 * time=0 returns the most recent flight track (current or last completed).
 * Returns the parsed response object or null if unavailable.
 * Results are cached for HISTORICAL_TRACK_TTL ms to prevent rate-limit hammering.
 */
async function fetchOpenSkyHistoricalTrack(icao24) {
    const cached = historicalTrackCache.get(icao24);
    if (cached && (Date.now() - cached.timestamp < HISTORICAL_TRACK_TTL)) {
        return cached.data;
    }

    try {
        if (accountPool._accounts.length === 0) return null;
        // OpenSky 已全面改用 OAuth2 Bearer Token，Basic Auth 已棄用
        const { headers: basicHeaders, account: histAccount } = await accountPool.getHeaders();
        const url = `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`;

        const res = await fetch(url, {
            headers: basicHeaders,
            signal: AbortSignal.timeout(5000)
        });
        accountPool.recordResponse(histAccount, res.status, res.headers);

        if (!res.ok) {
            // 404 = no track data for this aircraft, cache as null to avoid retries
            historicalTrackCache.set(icao24, { data: null, timestamp: Date.now() });
            return null;
        }

        const data = await res.json();
        historicalTrackCache.set(icao24, { data, timestamp: Date.now() });
        return data;
    } catch (e) {
        logger.debug('TRACK', `OpenSky historical unavailable for ${icao24}: ${e.message}`);
        historicalTrackCache.set(icao24, { data: null, timestamp: Date.now() });
        return null;
    }
}

/**
 * Fetch track for an aircraft using only locally stored TrackPoint data.
 * Points are keyed by FlightSession.sessionId to ensure current-flight isolation.
 */
async function fetchTracksInternal(icao24) {
    if (false) {  // store always ready
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
        let session = await FlightSession.findOne({ icao24: icao });

        let localPoints = [];
        if (session) {
            localPoints = await TrackPoint.find({ sessionId: { $in: [session.sessionId] } });
        }

        if (localPoints.length < 5) {
            const flightStartBound = session
                ? session.startTime
                : new Date(Date.now() - 2 * 60 * 60 * 1000);

            // SQLite fallback: fetch by icao24 since session start
            const db = require('./db/sqlite');
            const cutoff = Math.floor(new Date(flightStartBound).getTime() / 1000);
            const fallbackRows = db.prepare(
                'SELECT * FROM track_points WHERE icao24 = ? AND ts >= ? ORDER BY ts ASC LIMIT 15000'
            ).all(icao, cutoff);
            const fallbackPoints = fallbackRows.map(r => ({
                sessionId: r.session_id, icao24: r.icao24,
                timestamp: new Date(r.ts * 1000),
                lat: r.lat, lng: r.lng, altitude: r.altitude,
                velocity: r.velocity, heading: r.heading, onGround: !!r.on_ground
            }));

            if (fallbackPoints.length > localPoints.length) {
                console.log(`📡 [TRACK FALLBACK] ${icao24}: ${fallbackPoints.length} pts since session start (${flightStartBound.toISOString()})`);
                localPoints = fallbackPoints;
            }
        }
        
        // [v14] OpenSky Historical Track Augmentation
        // When local data is sparse (< 20 pts), fetch the full current-flight track from
        // OpenSky. This provides FR24-style path from takeoff, not just from server start.
        // Filtered to current session only — never mixes in previous flights.
        if (localPoints.length < 20) {
            try {
                const osTrack = await fetchOpenSkyHistoricalTrack(icao);
                if (osTrack && Array.isArray(osTrack.path) && osTrack.path.length > 0) {
                    // Use session.startTime as the flight boundary — exclude any earlier flights.
                    // Add 2-minute tolerance for sensor lag at takeoff.
                    const flightStartUnix = session
                        ? Math.floor(session.startTime.getTime() / 1000) - 120
                        : Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);

                    // OpenSky path: [time, lat, lng, baro_altitude, true_track, on_ground]
                    const osFiltered = osTrack.path.filter(p =>
                        p[0] >= flightStartUnix &&
                        typeof p[1] === 'number' && p[1] !== 0 &&
                        typeof p[2] === 'number' && p[2] !== 0
                    );

                    if (osFiltered.length > localPoints.length) {
                        // Convert to TrackPoint-like objects for uniform handling
                        const osConverted = osFiltered.map(p => ({
                            timestamp: new Date(p[0] * 1000),
                            lat: p[1],
                            lng: p[2],
                            altitude: typeof p[3] === 'number' ? p[3] : 0,
                            heading: typeof p[4] === 'number' ? p[4] : 0,
                            velocity: 0,
                            onGround: !!p[5]
                        }));

                        // Merge: local points override OpenSky for the same second
                        // (local data has higher update rate and precision)
                        const mergedMap = new Map();
                        osConverted.forEach(p => mergedMap.set(Math.round(p.timestamp.getTime() / 1000), p));
                        localPoints.forEach(p => mergedMap.set(Math.round(p.timestamp.getTime() / 1000), p));
                        localPoints = Array.from(mergedMap.values()).sort((a, b) => a.timestamp - b.timestamp);

                        logger.info('TRACK', `Historical augment OK: ${icao24} — ${osFiltered.length} OpenSky pts merged → ${localPoints.length} total`);
                    }
                }
            } catch (osErr) {
                logger.debug('TRACK', `Historical augment failed for ${icao24}: ${osErr.message}`);
            }
        }

        // Build final path array — deduplicate consecutive identical coordinates
        // (handles legacy data and OpenSky snapshots with repeated positions)
        const rawPath = localPoints.map(pt => [
            Math.floor(pt.timestamp.getTime() / 1000),
            pt.lat, pt.lng, pt.altitude || 0, pt.heading || 0, pt.velocity || 0, pt.onGround ? 1 : 0
        ]);
        const path = rawPath.filter((pt, i) => {
            if (i === 0) return true;
            const prev = rawPath[i - 1];
            return pt[1] !== prev[1] || pt[2] !== prev[2];
        });

        const result = { icao24, path };
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
        const session = await FlightSession.findOne({ sessionId: id });
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const points = await TrackPoint.find({ sessionId: { $in: [id] } });

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
        const allSessions = await FlightSession.find(filter);
        const sessions = allSessions
            .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
            .slice(0, limit);

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
    if (false) {  // store always ready
        return res.status(503).json({ error: 'Database not connected' });
    }

    try {
        const icao = req.query.icao;
        if (icao) {
            const found = await Metar.findOne({ icaoId: icao.toUpperCase() });
            return res.json(found || { error: 'Airport not found' });
        }
        const all = await Metar.find({});
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
            Aircraft.findOne({ $or: [{ icao24: hex }, { hex: hex }] }) .catch(() => null),
            Route.findOne({ callsign }) .catch(() => null)
        ]);
        
        const AIRCRAFT_TTL = 30 * 24 * 60 * 60 * 1000; // 30 Days
        const ROUTE_TTL = 4 * 60 * 60 * 1000;         // 4 Hours — cargo/charter airlines swap legs frequently

        const isAircraftFresh = dbAircraft && (Date.now() - new Date(dbAircraft.lastUpdated).getTime() < AIRCRAFT_TTL);
        const isRouteFresh = dbRoute && (Date.now() - new Date(dbRoute.lastUpdated).getTime() < ROUTE_TTL);

        // --- Step 2: Live state from in-memory cache (no extra API call) ---
        // globalPlanesCache is refreshed every 10s. Avoids burning OpenSky quota
        // for individual per-aircraft queries on every sidebar click.
        const liveState = (globalPlanesCache.states || []).find(p => p.icao24 === hex) || null;

        if (!liveState) {
            // Aircraft not in live cache (landed / left coverage) — return static DB data if available
            if (dbAircraft) {
                return res.json({
                    hex, callsign,
                    aircraft: { registration: dbAircraft.registration, model: dbAircraft.model, typecode: dbAircraft.typecode, operator: dbAircraft.operator },
                    route: { origin: { iata: dbRoute?.origin_iata || 'N/A' }, destination: { iata: dbRoute?.destination_iata || '---' } },
                    status: null,
                    source: 'db_static_only'
                });
            }
            return res.status(404).json({ error: 'AIRCRAFT_NOT_IN_CACHE' });
        }

        // Route cache is only valid when the plane is on the ground — an airborne aircraft
        // may be on a different leg than the one previously cached for this callsign.
        const isOnGround = liveState.onGround === true;
        const isRouteTrusted = isRouteFresh && isOnGround;

        // Local DB has full data — skip all external enrichment API calls
        const hasLocalAircraftData = isAircraftFresh && dbAircraft?.registration && dbAircraft.registration !== 'N/A'
            && (dbAircraft.typecode || dbAircraft.type_code);
        if (hasLocalAircraftData && isRouteTrusted) {
            console.log(`🎯 [DB HIT] Serving cached knowledge for ${hex}/${callsign}`);
            const fused = await finalizeProfile(dbAircraft, dbRoute, liveState);
            flightDetailsCache.set(cacheKey, fused);
            return res.json({ ...fused, source: 'db_knowledge_base' });
        }

        console.log(`⚡ [ENRICHMENT] DB Stale or Missing. Fusing external sources...`);
        // --- Step 3: [RESILIENT ENRICHMENT] ---
        // Skip hexdb + planespotters if local DB already has registration & typecode
        // (populated by Mictronics sync or Airplanes.Live write-back). Only fetch what's missing.
        const needsAircraftMeta = !hasLocalAircraftData;
        const enrichment = await Promise.allSettled([
            // a. HexDB — only if local DB doesn't already have the aircraft specs
            needsAircraftMeta
                ? fetch(`https://hexdb.io/api/v1/aircraft/${hex}`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok ? r.json() : null).catch(() => null)
                : Promise.resolve(null),
            // b. Planespotters — only if we don't already have a photo cached
            (!dbAircraft?.photo_url && !dbAircraft?.photoData?.url)
                ? fetch(`https://api.planespotters.net/pub/photos/hex/${hex}`, { headers: { 'User-Agent': 'AEROSTRAT/5.0' }, signal: AbortSignal.timeout(4000) }).then(r => r.ok ? r.json() : null).catch(() => null)
                : Promise.resolve(null),
            // c. Route — only if airborne (grounded aircraft route doesn't matter) and not recently cached
            (!isOnGround && !isRouteFresh)
                ? fetchRouteData(callsign)
                : Promise.resolve(null),
            // d. adsb.fi — skip if local DB already has full data
            needsAircraftMeta
                ? fetch(`https://opendata.adsb.fi/api/v2/hex/${hex}`, { headers: { 'User-Agent': 'AEROSTRAT/5.0' }, signal: AbortSignal.timeout(4000) })
                    .then(r => r.ok ? r.json() : null)
                    .then(d => (d?.aircraft?.[0] || null))
                    .catch(() => null)
                : Promise.resolve(null)
        ]);

        const [hexRes, photoRes, routeRes, adsbfiRes] = enrichment.map(r => r.status === 'fulfilled' ? r.value : null);
        if (adsbfiRes) console.log(`✈️ [ADSB.FI] ${hex}: r=${adsbfiRes.r} t=${adsbfiRes.t} op=${adsbfiRes.ownOp}`);

        // --- Step 4: [PERSISTENCE] Smart Normalization & Upsert ---
        // Priority: adsb.fi (live enriched) > hexdb.io (static) > local DB
        const aircraftUpdate = {
            hex,
            icao24: hex,
            type: adsbfiRes?.t || hexRes?.typeName || hexRes?.type || dbAircraft?.type || dbAircraft?.model || 'Unknown',
            model: adsbfiRes?.desc || hexRes?.typeName || hexRes?.type || dbAircraft?.model || 'Unknown',
            type_code: adsbfiRes?.t || hexRes?.type || dbAircraft?.type_code || null,
            typecode: adsbfiRes?.t || hexRes?.type || dbAircraft?.typecode || null,
            manufacturer: hexRes?.icaotype || dbAircraft?.manufacturer || 'Unknown',
            registration: adsbfiRes?.r || hexRes?.registration || dbAircraft?.registration || 'N/A',
            airline: adsbfiRes?.ownOp || hexRes?.operator || dbAircraft?.airline || dbAircraft?.registered_owner || 'Unknown Airline',
            operator: adsbfiRes?.ownOp || hexRes?.operator || dbAircraft?.operator || 'Unknown Airline',
            registered_owner: adsbfiRes?.ownOp || hexRes?.operator || dbAircraft?.registered_owner || 'Unknown Airline',
            photo_url: photoRes?.photos?.[0]?.thumbnail_large?.src || dbAircraft?.photo_url || dbAircraft?.photoData?.url || null,
            lastUpdated: new Date()
        };
        const updatedAircraft = await Aircraft.findOneAndUpdate({ $or: [{ icao24: hex }, { hex: hex }] }, { $set: aircraftUpdate }, { upsert: true, returnDocument: 'after' });
 
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
        const updatedRoute = await Route.findOneAndUpdate({ callsign }, { $set: routeUpdate }, { upsert: true, returnDocument: 'after' });
 
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
            const airport = await Airport.findOne({ $or: [{ iata: destIata }, { icao: destIata }] });
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
        console.log(`║   📋 Logs: logs/                  ║`);
        console.log('╚══════════════════════════════════════════╝');
        console.log('');
        logger.info('SERVER', `AEROSTRAT ${AEROSTRAT_VERSION} started on port ${PORT} | heap: ${memMB}MB | LOG_LEVEL: ${process.env.LOG_LEVEL || 'INFO'}`);
    });
}

startServer();
