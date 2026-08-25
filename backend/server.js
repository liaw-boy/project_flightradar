const config = require('./config');
const logger = require('./logger');
const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cron = require('node-cron');
const { Worker } = require('worker_threads');
const http = require('http');
const zlib = require('zlib');
const readline = require('readline');
const { initWebSocketServer, broadcastPlanes, broadcastTelemetry, broadcastTrackPoint, getActiveViewports, getClientCount } = require('./socketEngine');
// ── New store layer (replaces MongoDB models) ───────────────────────────
const Aircraft      = require('./db/aircraftStore');
const Route         = require('./db/routeStore');
const Metar         = require('./db/metarStore');
const MictronicsDb  = require('./db/mictronicsDb');
const VrsDb         = require('./db/vrsDb');
const { syncMictronics } = require('./scripts/syncMictronics');
const { syncVrsRoutes } = require('./scripts/syncVrsRoutes');
const syncLog = require('./db/syncLogger');
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
// [v12.8] CPU Usage Tracker (Task Manager Logic)
// ==========================================
function getCpuStats() {
    const cpus = os.cpus();
    let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
    for (const cpu of cpus) {
        user += cpu.times.user;
        nice += cpu.times.nice;
        sys += cpu.times.sys;
        idle += cpu.times.idle;
        irq += cpu.times.irq;
    }
    const total = user + nice + sys + idle + irq;
    return { idle, total };
}
let _lastCpuStats = getCpuStats();
let _currentCpuUsage = 0;

setInterval(() => {
    const stats = getCpuStats();
    const idleDiff = stats.idle - _lastCpuStats.idle;
    const totalDiff = stats.total - _lastCpuStats.total;
    _currentCpuUsage = totalDiff > 0 ? (1 - (idleDiff / totalDiff)) * 100 : 0;
    _lastCpuStats = stats;
}, 2000);

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
app.disable('x-powered-by'); // Don't advertise the framework/version to every response
const PORT = config.PORT;

// ==========================================
// Middleware
// ==========================================
const { corsMiddleware, helmetMiddleware } = require('./middleware/security');
const { apiLimiter, fusionLimiter, lookupLimiter, monitorLoginLimiter } = require('./middleware/rateLimiters');
const { registerFrontendStatic, registerSvgRoutes, registerAirlineAssetRoutes } = require('./routes/staticAssets');

app.use(corsMiddleware);
app.use(compression()); // [v2.9.0] Gzip
app.use(logger.httpMiddleware); // [LOG] HTTP request logging (skips high-freq endpoints)

// [v3.0] Security Headers — MUST run before any static/SPA route registration
// below. This used to sit after the static file + SPA fallback routes, which
// meant Express resolved and answered every request for index.html and every
// bundled JS/CSS asset before helmet ever ran — the actual page users load
// shipped with no CSP, no HSTS, no X-Frame-Options, no nosniff at all. Only
// /api/* JSON responses (which register after this point) ever got these
// headers. Confirmed live via `curl -I` against both the document and an API
// route before this fix: the API response carried the full helmet header
// set, the document response carried none of it.
app.use(helmetMiddleware);

// [v5.0.0] Production static file serving — built frontend from public-react/
// In development, Vite dev server handles the frontend on port 3005.
// In production (Docker), serve the pre-built React app directly.
registerFrontendStatic(app, __dirname);

// [v12.5] Aircraft SVG silhouettes served locally (avoids GitHub CDN 404s/rate-limits)
registerSvgRoutes(app, __dirname);

// Airline logos/banners (Jxck-S/airline-logos, ICAO-named PNGs)
registerAirlineAssetRoutes(app, __dirname);

app.use('/api', apiLimiter);
app.use('/api/flight/complete-details', fusionLimiter);
app.use('/api/lookup', lookupLimiter);
app.use(cookieParser());
app.use(express.json());

const db = require('./db/sqlite');
const {
    getMonitorToken, isAdminAuthed, requireMonitorAuth, requireAdminAccess,
    isMonitorPasswordValid, createMonitorSession, destroyMonitorSession,
    getLoginHtml, MONITOR_SESSION_TTL,
} = require('./middleware/monitorAuth');

// ── Flight lookup helpers (no auth required, uses local VRS DB) ──────────────
app.get('/api/lookup/callsign/:cs', async (req, res) => {
    const cs = (req.params.cs || '').toUpperCase().trim();
    if (!cs) return res.json({ found: false });

    // helper: ICAO → IATA (fallback to original code)
    const toIata = (code) => {
        if (!code) return null;
        if (code.length === 3) return code; // already IATA
        return VrsDb.lookupAirport(code)?.iata || code;
    };

    // helper: convert IATA airline prefix to ICAO (e.g. CI101 → CAL101)
    const toIcaoCallsign = (callsign) => {
        const m = callsign.match(/^([A-Z]{2})(\d.*)$/);
        if (!m) return null;
        const airline = VrsDb.lookupAirlineByIata(m[1]);
        if (!airline?.icao) return null;
        return airline.icao + m[2];
    };

    // If user passed IATA airline prefix (e.g. CI101), also try the ICAO form (CAL101)
    const csIcao = toIcaoCallsign(cs);

    // Layer 0: Live planes cache — get registration + typecode for this callsign
    const livePlane = globalPlanesCache.states.find(p =>
        p.callsign && (p.callsign.toUpperCase() === cs || (csIcao && p.callsign.toUpperCase() === csIcao))
    );
    const liveRegistration = livePlane?.registration || null;
    const liveTypecode     = livePlane?.typecode     || null;

    // Layer 1: Route cache (today's real data — highest trust)
    let dbRoute = null;
    try {
        dbRoute = await Route.findOne({ callsign: cs }) ||
                  (csIcao ? await Route.findOne({ callsign: csIcao }) : null);
        // Reject stale spatial_inference entries — they're position guesses, not schedules
        if (dbRoute?.source === 'spatial_inference') dbRoute = null;
    } catch (_) {}

    const liveExtra = { registration: liveRegistration, typecode: liveTypecode };

    if (dbRoute?.departureAirport && dbRoute?.arrivalAirport) {
        return res.json({
            found:    true,
            dep_iata: toIata(dbRoute.departureAirport),
            arr_iata: toIata(dbRoute.arrivalAirport),
            dep_name: dbRoute.origin_name      || null,
            arr_name: dbRoute.destination_name || null,
            dep_time: dbRoute.departure_time   || null,
            arr_time: dbRoute.arrival_time     || null,
            ...liveExtra,
        });
    }

    // Layer 2: adsbdb.com — community-sourced, no quota, returns current scheduled route
    try {
        const adsbdbRes = await fetch(`https://api.adsbdb.com/v0/callsign/${cs}`, {
            headers: { 'User-Agent': 'AEROSTRAT/12.0' },
            signal: AbortSignal.timeout(4000),
        });
        if (adsbdbRes.ok) {
            const adsbdbData = await adsbdbRes.json();
            const fl = adsbdbData?.response?.flightroute;
            if (fl?.origin?.icao_code && fl?.destination?.icao_code) {
                Route.findOneAndUpdate(
                    { callsign: cs },
                    { $set: { departureAirport: fl.origin.icao_code, arrivalAirport: fl.destination.icao_code, source: 'adsbdb', lastUpdated: new Date() } },
                    { upsert: true }
                ).catch(() => null);
                return res.json({
                    found:    true,
                    dep_iata: fl.origin.iata_code  || toIata(fl.origin.icao_code),
                    arr_iata: fl.destination.iata_code || toIata(fl.destination.icao_code),
                    dep_name: fl.origin.name       || null,
                    arr_name: fl.destination.name  || null,
                    dep_time: null,
                    arr_time: null,
                    ...liveExtra,
                });
            }
        }
    } catch (_) { /* timeout — continue */ }

    // Layer 3: VRS SQLite (static, fast; multi-leg entries already filtered in vrsDb.lookup)
    const vrsRoute = VrsDb.lookup(cs) || (csIcao ? VrsDb.lookup(csIcao) : null);
    const vrsDep = vrsRoute?.from ? VrsDb.lookupAirport(vrsRoute.from) : null;
    const vrsArr = vrsRoute?.to   ? VrsDb.lookupAirport(vrsRoute.to)   : null;

    if (vrsRoute?.from || vrsRoute?.to) {
        return res.json({
            found:    true,
            dep_iata: toIata(vrsRoute.from),
            arr_iata: toIata(vrsRoute.to),
            dep_name: vrsDep?.name || null,
            arr_name: vrsArr?.name || null,
            dep_time: null,
            arr_time: null,
            ...liveExtra,
        });
    }

    // Layer 4: AeroDataBox live lookup
    const adData = await fetchRouteData(cs);
    if (adData && (adData.origin_iata || adData.destination_iata)) {
        return res.json({
            found:    true,
            dep_iata: adData.origin_iata      !== 'N/A' ? adData.origin_iata      : null,
            arr_iata: adData.destination_iata !== '---' ? adData.destination_iata : null,
            dep_name: adData.origin_name      || null,
            arr_name: adData.destination_name || null,
            dep_time: adData.departure_time   || null,
            arr_time: adData.arrival_time     || null,
            ...liveExtra,
        });
    }

    // Layer 5: OpenFlights (exact callsign match from schedules_global.json)
    const ofExact = openflightsGlobalDB[cs] || (csIcao ? openflightsGlobalDB[csIcao] : null);
    if (ofExact?.dep && ofExact?.arr) {
        return res.json({
            found:    true,
            dep_iata: ofExact.dep,
            arr_iata: ofExact.arr,
            dep_name: null,
            arr_name: null,
            dep_time: null,
            arr_time: null,
            source:   'openflights',
            ...liveExtra,
        });
    }

    // No route found — still return live aircraft info if available
    if (liveRegistration || liveTypecode) {
        return res.json({ found: false, ...liveExtra });
    }

    return res.json({ found: false });
});

app.get('/api/lookup/airport/:code', (req, res) => {
    const code = (req.params.code || '').toUpperCase().trim();
    if (!code) return res.json({ found: false });
    const ap = VrsDb.lookupAirport(code);
    if (!ap) return res.json({ found: false });
    return res.json({ found: true, icao: ap.icao, iata: ap.iata, name: ap.name, country: ap.country_iso });
});

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

        // e. [Internal Cache] Local Aircraft store metadata (Phase 7 Correction Priority)
        Aircraft.findOne({ icao24: hex }) .catch(() => null)
    ]);

    // 3. Data Normalization (MergedFlightData)
    const [osRes, routeRes, hexRes, photoRes, localRes] = results.map(r => r.status === 'fulfilled' ? r.value : null);

    const osState = osRes?.states?.[0] || {};
    const routeInfo = routeRes?.[0] || {};
    const aircraftInfo = hexRes || {};
    const photoData = photoRes?.photos?.[0] || {};
    const localInfo = localRes || {};

    // VRS fallback: if AeroDataBox has no route, try local VRS SQLite (skip multi-leg entries)
    const vrsRoute = VrsDb.lookup(callsign);
    const vrsIsMultiLeg = vrsRoute?.raw ? (vrsRoute.raw.match(/-/g) || []).length > 1 : false;
    const originIata  = routeInfo.departure?.airport?.iata  || (!vrsIsMultiLeg && vrsRoute?.from) || 'N/A';
    const destIata    = routeInfo.arrival?.airport?.iata    || (!vrsIsMultiLeg && vrsRoute?.to)   || '---';

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
                iata: originIata,
                name: routeInfo.departure?.airport?.name || 'Unknown Airport',
                city: routeInfo.departure?.airport?.municipalityName || 'Location Unavailable'
            },
            destination: {
                iata: destIata,
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

app.get('/api/admin/missing-data', requireMonitorAuth, (req, res) => {
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

            // SQLite stores timestamps as integers (unix ms); wrap if not a Date
            const tsToMs = (v) => v instanceof Date ? v.getTime() : Number(v);
            const lastTs = lastPoint ? tsToMs(lastPoint.timestamp) : 0;
            const startTs = session.startTime ? tsToMs(session.startTime) : null;
            if (lastPoint && (now - lastTs < STALE_THRESHOLD)) {
                activeSessions.set(session.icao24, {
                    sessionId: session.sessionId,
                    callsign: session.callsign || 'N/A',
                    lastSeen: lastTs,
                    startTime: startTs ? Math.floor(startTs / 1000) : null,
                    onGround: !!lastPoint.onGround
                });
                restoredCount++;
            } else {
                const endTime = lastPoint ? new Date(tsToMs(lastPoint.timestamp)) : new Date();
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
                // Extract rich schedule & gate info
                const depSched   = f.departure?.scheduledTimeLocal || f.departure?.scheduledTimeUtc || null;
                const depRevised = f.departure?.revisedTimeLocal   || f.departure?.revisedTimeUtc   || null;
                const arrSched   = f.arrival?.scheduledTimeLocal   || f.arrival?.scheduledTimeUtc   || null;
                const arrRevised = f.arrival?.revisedTimeLocal     || f.arrival?.revisedTimeUtc     || null;
                const fmtTime = (s) => {
                    if (!s) return null;
                    const d = new Date(s);
                    if (isNaN(d)) return s;
                    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
                };
                return {
                    origin_iata:        f.departure?.airport?.iata || 'N/A',
                    origin_name:        f.departure?.airport?.name || null,
                    origin_city:        f.departure?.airport?.municipalityName || null,
                    destination_iata:   f.arrival?.airport?.iata || '---',
                    destination_icao:   f.arrival?.airport?.icao || null,
                    destination_name:   f.arrival?.airport?.name || null,
                    destination_city:   f.arrival?.airport?.municipalityName || null,
                    departure_time:     fmtTime(depRevised || depSched),
                    departure_scheduled:fmtTime(depSched),
                    departure_revised:  fmtTime(depRevised),
                    departure_terminal: f.departure?.terminal || null,
                    departure_gate:     f.departure?.gate || null,
                    arrival_time:       fmtTime(arrRevised || arrSched),
                    arrival_scheduled:  fmtTime(arrSched),
                    arrival_revised:    fmtTime(arrRevised),
                    arrival_terminal:   f.arrival?.terminal || null,
                    arrival_gate:       f.arrival?.gate || null,
                    flightNumber:       f.number || null,
                    flightStatus:       f.status || null,
                    airline_name:       f.airline?.name || null,
                    estimated_arrival_time: arrRevised || arrSched || null,
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
const accountPool = new AccountPool(_rawAccounts, { safeFloor: 5 });

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

    // 心跳機制：每 5 秒發送 data 訊息（comment ping 不觸發 onmessage，改用 data）
    const heartbeat = setInterval(() => {
        try { res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`); }
        catch (e) { sseClients.delete(res); clearInterval(heartbeat); }
    }, 5000);

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
// Protected by MONITOR_TOKEN env var (預設 'dev' 僅限本
const { getMonitorHtml } = require('./views/monitorDashboard');

app.get('/monitor', (req, res) => {
    if (!isAdminAuthed(req)) {
        return res.status(401).send(getLoginHtml());
    }
    res.send(getMonitorHtml(AEROSTRAT_VERSION));
});

app.use('/monitor', express.urlencoded({ extended: false }));

app.post('/monitor/login', monitorLoginLimiter, (req, res) => {
    const { password } = req.body;
    if (!isMonitorPasswordValid(password)) {
        return res.status(401).send(getLoginHtml('密碼錯誤，請再試一次'));
    }
    const token = createMonitorSession();
    const securePart = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `monitor_session=${token}; HttpOnly; SameSite=Strict; Path=/${securePart}; Max-Age=${MONITOR_SESSION_TTL / 1000}`);
    res.redirect('/monitor');
});

app.get('/monitor/logout', (req, res) => {
    const token = getMonitorToken(req);
    destroyMonitorSession(token);
    res.setHeader('Set-Cookie', 'monitor_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.redirect('/monitor');
});

// ── Monitor User Management API (monitor session auth) ────────────
// ── DB Status API ─────────────────────────────────────────────────────────────
app.get('/monitor/api/db-status', requireMonitorAuth, (req, res) => {
    const sqliteDb  = require('./db/sqlite');
    const routesDb  = require('better-sqlite3');
    const routesPath = path.join(__dirname, 'data', 'routes.db');
    const mainPath   = path.join(__dirname, 'data', 'aerostrat.db');

    // ── Main DB (aerostrat.db) ───────────────────────────────────────────────
    const main = { tables: {}, sizeBytes: 0 };
    try {
        main.sizeBytes = fs.existsSync(mainPath) ? fs.statSync(mainPath).size : 0;
        const tables = ['track_points','flight_sessions','users','user_flights'];
        tables.forEach(t => {
            try {
                main.tables[t] = {
                    rows:    sqliteDb.prepare(`SELECT COUNT(*) as n FROM ${t}`).get().n,
                    sizeMb:  Math.round((sqliteDb.prepare(`SELECT SUM(pgsize) as s FROM dbstat WHERE name=?`).get(t)?.s || 0) / 1024 / 1024 * 10) / 10,
                };
            } catch (_) { main.tables[t] = { rows: 0, sizeMb: 0 }; }
        });
    } catch (_) {}

    // ── Routes DB (routes.db) ────────────────────────────────────────────────
    const routes = { tables: {}, sizeBytes: 0 };
    try {
        routes.sizeBytes = fs.existsSync(routesPath) ? fs.statSync(routesPath).size : 0;
        if (routes.sizeBytes > 0) {
            const rdb = new (routesDb)(routesPath, { readonly: true });
            const rTables = ['routes','airports','airlines','model_types'];
            rTables.forEach(t => {
                try {
                    routes.tables[t] = {
                        rows:   rdb.prepare(`SELECT COUNT(*) as n FROM ${t}`).get().n,
                        sizeMb: Math.round((rdb.prepare(`SELECT SUM(pgsize) as s FROM dbstat WHERE name=?`).get(t)?.s || 0) / 1024 / 1024 * 10) / 10,
                    };
                } catch (_) { routes.tables[t] = { rows: 0, sizeMb: 0 }; }
            });
            rdb.close();
        }
    } catch (_) {}

    // ── VRS standing-data git info ────────────────────────────────────────────
    let vrsGitCommit = null;
    try {
        const { execSync } = require('child_process');
        const sdDir = path.join(__dirname, 'data', 'standing-data');
        if (fs.existsSync(sdDir)) {
            vrsGitCommit = execSync('git log -1 --format="%h %ai"', { cwd: sdDir, encoding: 'utf8', stdio: 'pipe' }).trim();
        }
    } catch (_) {}

    // ── Mictronics last sync ─────────────────────────────────────────────────
    let mictLastSync = null;
    try { mictLastSync = MictronicsDb.lastSyncTime?.(); } catch (_) {}

    res.json({
        main,
        routes,
        sync: {
            vrs:        { ...dbSyncStatus.vrs,        gitCommit: vrsGitCommit },
            mictronics: { ...dbSyncStatus.mictronics, lastSyncUnix: mictLastSync },
            schedules:  { ...dbSyncStatus.schedules },
            _all:       syncLog.getAll(),
        },
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

// A source held open by its circuit breaker used to fail silently — the skip
// path logged nothing, so a permanently dead upstream (adsb.fi's /snapshot
// started returning 403) looked identical to a healthy one in the logs.
// Report it, throttled per source so a long outage doesn't flood the log.
const CB_LOG_THROTTLE_MS = 10 * 60_000;
const _cbLoggedAt = {};
function logSuppressedSource(key) {
    const now = Date.now();
    if (now - (_cbLoggedAt[key] || 0) < CB_LOG_THROTTLE_MS) return;
    _cbLoggedAt[key] = now;
    const until = sourceHealth[key]?.cbUntil || now;
    const fails = sourceHealth[key]?.consecutiveFails || 0;
    logger.warn('SYNC', `${key} suppressed by circuit breaker — ${Math.ceil((until - now) / 60_000)} min left, ${fails} consecutive failures`);
}

// ── ICAO 24-bit address classification ────────────────────────────────────
// A real ICAO address is exactly 6 hex digits. '000000' / '000001' / 'ffffff'
// are unassigned sentinels that misconfigured feeders emit — '000001' alone
// had accumulated 8,149 phantom flight sessions, as if one aircraft had flown
// 8,149 separate legs.
const RESERVED_ICAO24 = new Set(['000000', '000001', 'ffffff']);
const isRealIcao24 = hex =>
    typeof hex === 'string' && /^[0-9a-f]{6}$/.test(hex) && !RESERVED_ICAO24.has(hex);

// adsb.lol (ADSBexchange format) prefixes non-ICAO targets — TIS-B and ADS-R
// ground rebroadcasts — with '~'. They carry no registry-resolvable address,
// so no lookup can ever give them a type, registration or operator. They stay
// on the live map (they are real traffic, ~0.5% of the feed) but are kept out
// of session/track persistence, where they had produced 217k junk sessions.
const isNonIcaoTarget = hex => typeof hex === 'string' && hex.startsWith('~');

// ADS-B "signal source" labels — not aircraft types. These come from the
// `type` field on some feeder formats (as opposed to `t`, the real typecode)
// and previously got written into typecode by mistake (`p.t || p.type`,
// fixed in normalizeAcRecord). The bug is fixed at the point of ingest, but
// polluted values from before the fix still sit in aircraft_cache.json and
// get read back in here via Aircraft.find()/aircraftMetadataIndex — without
// this guard, one bad cached value keeps re-entering masterStateMap and
// getting written straight back out via the Phase 1 writeback below,
// refreshing its timestamp and making it look "current" forever.
const SIGNAL_SOURCE_LABELS = /^(adsb|adsr|tisb|mlat|other|unknown|mode)/i;
const isValidTypecode = tc => typeof tc === 'string' && tc.length > 0 && !SIGNAL_SOURCE_LABELS.test(tc);

// ── Merge helper ───────────────────────────────────────────────────────────
// strategy='upsert': full replacement (Tier 1 global baseline)
// strategy='merge' : keep existing fields, only update non-null new values (Tier 2/3 overlays)
// Positional fields subject to time/plausibility arbitration below. Every
// other field (squawk, callsign, enrichment, isMil, ...) is always allowed
// to update regardless of position freshness — only the "where is it"
// component gets held back when it's suspect.
const POSITION_FIELDS = ['lat', 'lng', 'heading', 'altitude', 'velocity', 'onGround'];

// Root cause of the "moves forward then snaps back" symptom users saw: Tier 1
// (global adsb.lol baseline, 5s) and Tier 2 (per-viewport airplanes.live/
// re-api overlay, 5s) both write the same icao24 into masterStateMap with no
// coordination — this was confirmed live by capturing 4 minutes of WS traffic
// and finding aircraft with two DIFFERENT positions reported for the same
// nominal second. Previously mergeStates() was pure last-writer-wins keyed
// only on server receive time (`now`), so whichever fetch happened to finish
// last on the event loop won, independent of which one actually measured the
// aircraft's position more recently. Track-point history inherited the same
// corruption, since ingestTrackPoints() reads straight out of this map.
//
// Two independent guards, because they catch different failure modes:
//  1. Monotonic posTime — rejects genuinely stale data that arrives late
//     (out-of-order delivery). Confirmed to fully eliminate that class.
//  2. Implied-speed sanity check — for updates that DO have a newer posTime,
//     catches two sources disagreeing about the same instant (same/adjacent
//     timestamp, different coordinates) by cross-checking the position delta
//     against the aircraft's own reported velocity. A pure timestamp check
//     can't order these away because they aren't actually out of order.
const IMPLIED_SPEED_FLOOR_MPS = 15; // below this, GPS/quantization noise alone can look "too fast" — don't flag
const IMPLIED_SPEED_RATIO = 3;      // implied speed must exceed 3x the aircraft's own reported speed to be rejected
const REVERSAL_MIN_DIST_M = 60;     // below this, bearing is too noisy to mean anything — don't flag
const REVERSAL_ANGLE_DEG = 120;     // displacement bearing vs reported heading disagreeing by more than this = reversal

function initialBearingDeg(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function angleDiffDeg(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

function isPositionUpdateTrustworthy(existing, incoming) {
    if (!existing || typeof existing.lat !== 'number') return true; // first sighting — nothing to compare against
    const existingPosTime = existing.posTime;
    const incomingPosTime = incoming.posTime;
    if (existingPosTime == null || incomingPosTime == null) return true; // can't arbitrate without both timestamps

    if (incomingPosTime < existingPosTime) return false; // guard 1: older measurement — reject outright

    const dtSec = incomingPosTime - existingPosTime;
    if (dtSec <= 0) return true; // same instant, nothing to sanity-check against

    const distM = getDistance(existing.lat, existing.lng, incoming.lat, incoming.lng) * 1000;

    // Guard 2: does the aircraft's own reported heading agree with the direction
    // it apparently just moved? A real aircraft can't reverse course ~180° in a
    // few seconds — this is what actually flagged the "moves forward then snaps
    // back" symptom in production, catching cases a pure speed-ratio check missed
    // (two sources disagreeing by ~2km/3s implies ~690 m/s, which is still under
    // 3x a jet's own ~250 m/s cruise speed, so guard 3 alone let it through).
    if (distM > REVERSAL_MIN_DIST_M && !incoming.onGround) {
        const displacementBearing = initialBearingDeg(existing.lat, existing.lng, incoming.lat, incoming.lng);
        const reportedHeading = typeof incoming.heading === 'number' ? incoming.heading
            : (typeof existing.heading === 'number' ? existing.heading : null);
        if (reportedHeading != null && angleDiffDeg(displacementBearing, reportedHeading) > REVERSAL_ANGLE_DEG) {
            if (process.env.DEBUG_ARBITRATION) console.log(`[ARB-REJECT-BEARING] ${incoming.icao24} distM=${distM.toFixed(0)} dt=${dtSec.toFixed(1)}s bearing=${displacementBearing.toFixed(0)} heading=${reportedHeading.toFixed(0)}`);
            return false;
        }
    }

    // Guard 3: implied speed vastly exceeds the aircraft's own reported speed —
    // catches same-instant conflicts a pure timestamp check can't order away.
    const impliedMps = distM / dtSec;
    const reportedMps = typeof incoming.velocity === 'number' ? incoming.velocity
        : (typeof existing.velocity === 'number' ? existing.velocity : null);
    if (reportedMps != null && impliedMps > IMPLIED_SPEED_FLOOR_MPS && impliedMps > reportedMps * IMPLIED_SPEED_RATIO) {
        if (process.env.DEBUG_ARBITRATION) console.log(`[ARB-REJECT-SPEED] ${incoming.icao24} distM=${distM.toFixed(0)} dt=${dtSec.toFixed(1)}s impliedMps=${impliedMps.toFixed(0)} reportedMps=${reportedMps.toFixed(0)}`);
        return false;
    }
    return true;
}

function mergeStates(states, strategy = 'upsert') {
    const now = Date.now();
    for (const p of states) {
        if (!p.icao24 || typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
        // Sentinel addresses are not aircraft — drop before they reach the map.
        if (!isRealIcao24(p.icao24) && !isNonIcaoTarget(p.icao24)) continue;

        const existing = masterStateMap.get(p.icao24);
        let record = p;
        if (existing && !isPositionUpdateTrustworthy(existing, p)) {
            // Keep the trusted position; still let everything else (squawk,
            // callsign, enrichment fields) through from the new record.
            record = { ...p };
            for (const f of POSITION_FIELDS) record[f] = existing[f];
            record.posTime = existing.posTime;
        }

        if (strategy === 'merge') {
            const merged = { ...existing, ...record, _lastSeen: now };
            // Preserve richer metadata fields from existing if new record lacks them
            if (!p.description && existing?.description) merged.description = existing.description;
            if (!p.year        && existing?.year)        merged.year        = existing.year;
            if (!p.typecode    && existing?.typecode)    merged.typecode    = existing.typecode;
            if (!p.operator    && existing?.operator)    merged.operator    = existing.operator;
            if (!p.model       && existing?.model)       merged.model       = existing.model;
            masterStateMap.set(p.icao24, merged);
        } else {
            // 'upsert' (Tier 1) previously replaced the whole record wholesale
            // every 5s poll — raw ADS-B data has no operator/model field, so
            // enrichAndIngest()'s MictronicsDb-sourced operator/model got
            // silently wiped out on the very next baseline cycle, every cycle.
            // That's why the map-wide operator merge only ever showed ~21%
            // instead of Mictronics' actual ~80% hit rate against live
            // traffic: only whichever planes enrichAndIngest had *just*
          // touched, in the brief window before the next upsert, ever
            // showed it. Position/telemetry fields still come wholesale from
            // the new record (that data must always be fresh); only these
            // enrichment-only fields carry forward.
            const next = { ...record, _lastSeen: now };
            if (!next.operator && existing?.operator) next.operator = existing.operator;
            if (!next.model    && existing?.model)    next.model    = existing.model;
            if (!isValidTypecode(next.typecode) && isValidTypecode(existing?.typecode)) next.typecode = existing.typecode;
            masterStateMap.set(p.icao24, next);
        }
    }
}

// ── Broadcast cadence smoothing ─────────────────────────────────────────
// Tier 1 (global baseline) and Tier 2 (viewport overlay) each poll on their
// own independent 5s setInterval, unsynchronized with each other. Measured
// live: the resulting WebSocket delta arrival gaps swing anywhere from
// ~300ms to ~6800ms for the same set of aircraft, cycle to cycle — trigger-
// based throttling (only enforcing a minimum gap) doesn't fix this, since
// the *maximum* gap is still whatever the two unsynchronized 5s pollers
// happen to leave between their broadcasts. The frontend derives its
// interpolation duration from that arrival gap, so the same physical
// movement gets animated over a 0.3s window one moment and a 6s+ window the
// next; when two broadcasts land close together, the prior animation hasn't
// finished before the next target arrives, which reads visually as the
// plane snapping backward. The fix is a real fixed-cadence ticker, fully
// decoupled from when either tier happens to fire: pruneAndBroadcast() only
// marks state dirty; a separate setInterval flushes on a constant rhythm.
// This fixes the delivery-side half of the "忽快忽慢/前進倒退" symptom;
// isPositionUpdateTrustworthy() (mergeStates) fixes the data-side half.
const BROADCAST_INTERVAL_MS = 2000;
let _broadcastDirty = false;

function pruneAndBroadcast() {
    // Pruning + globalPlanesCache stay immediate — HTTP polling (/api/planes/bbox)
    // and other in-process consumers should never see stale-by-design data.
    const cutoff = Date.now() - PLANE_TTL_MS;
    for (const [id, p] of masterStateMap) {
        if ((p._lastSeen || 0) < cutoff) masterStateMap.delete(id);
    }
    const states = Array.from(masterStateMap.values());
    globalPlanesCache = { states, time: Math.floor(Date.now() / 1000), stale: false };
    _broadcastDirty = true; // picked up by the flush ticker below
}

setInterval(() => {
    if (!_broadcastDirty) return;
    _broadcastDirty = false;
    broadcastPlanes(globalPlanesCache.states, globalPlanesCache.time);
}, BROADCAST_INTERVAL_MS);

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

// ── OpenSky global baseline fallback ──────────────────────────────────────
// Last resort for Tier 1: runs only when both adsb.lol and adsb.fi return
// nothing. OpenSky bills credits per states/all call, so this is throttled
// independently of the 5s baseline cadence — a multi-minute upstream outage
// costs a handful of calls, not one every five seconds.
const OPENSKY_FALLBACK_MIN_GAP_MS = 30_000;
let _lastOpenSkyFallbackAt = 0;

async function fetchOpenSkyBaselineFallback() {
    if (cbOpen('opensky')) {
        logSuppressedSource('opensky');
        return [];
    }
    const now = Date.now();
    if (now - _lastOpenSkyFallbackAt < OPENSKY_FALLBACK_MIN_GAP_MS) return [];
    _lastOpenSkyFallbackAt = now;

    const t0 = performance.now();
    try {
        const { states } = await fetchOpenSky();
        const usable = (states || []).filter(
            p => p.icao24 && typeof p.lat === 'number' && typeof p.lng === 'number'
        );
        const ms = Math.round(performance.now() - t0);
        cbReset('opensky', usable.length, ms);
        logger.info('SYNC', `OpenSky fallback engaged: ${usable.length} planes | ${ms}ms`);
        return usable;
    } catch (e) {
        const msg = e?.message || String(e);
        // Quota exhaustion and rate limits both mean "stop asking for a while".
        if (msg.includes('429') || msg.includes('503') || /credit|quota/i.test(msg)) {
            cbTrip('opensky');
        }
        logger.warn('SYNC', `OpenSky fallback failed: ${msg}`);
        return [];
    }
}

/**
 * [v10.3] Shared normalizer for all adsb-format sources (adsb.lol, adsb.fi, airplanes.live).
 * All three return the same ADSBexchange v2 compatible format with `ac[]` array.
 * Extra fields (desc, ownOp, year, nav_modes) are passed through for DB write-back.
 */
// sourceNowMs: the API response's own `now` field (ms). Used to compute the true
// position timestamp regardless of server-clock drift between sources.
const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);

function normalizeAcRecord(p, sourceNowMs) {
    const nowSec = (sourceNowMs != null ? sourceNowMs : Date.now()) / 1000;
    const squawk = p.squawk || null;
    const posTime = p.seen_pos != null ? (nowSec - p.seen_pos) : null;
    return {
        icao24:      p.hex?.toLowerCase(),
        callsign:    (p.flight || '').trim(),
        lng:         p.lon,
        lat:         p.lat,
        altitude:    p.alt_baro === 'ground' ? 0 : (p.alt_baro || p.alt_geom || 0),
        velocity:    p.gs != null ? p.gs * 0.51444 : null,
        // p.track (ground track) is frequently null/0 while taxiing — ADS-B ground
        // track requires movement to compute. Fall back to the aircraft's own
        // true/magnetic heading (from its INS/magnetometer, independent of GPS
        // motion) before giving up and defaulting to 0, which previously made
        // every ground aircraft without a track render facing due north.
        heading:     p.track ?? p.true_heading ?? p.mag_heading ?? 0,
        vRate:       (p.baro_rate || 0) * 0.00508,
        onGround:    p.alt_baro === 'ground' || false,
        squawk,
        // isEmergency and lastContact were never set here, even though the
        // WebSocket delta wire format has always carried both fields — every
        // ADS-B-sourced plane silently sent `undefined` for them, so 7500/
        // 7600/7700 never lit up the emergency indicator on the frontend.
        isEmergency: EMERGENCY_SQUAWKS.has(squawk),
        lastContact: Math.floor(posTime != null ? posTime : nowSec),
        // p.type is the ADS-B *signal source* label (adsb_icao/tisb_other/
        // mlat/...), not an aircraft type — only p.t is ever a real typecode.
        // Falling back to p.type here was writing values like "tisb_other"
        // into the aircraft metadata cache as if they were the model, which
        // then blocked every downstream metadata lookup from ever retrying.
        typecode:    p.t || null,
        registration: p.r || null,
        operator:    p.ownOp || null,
        description: p.desc || null,
        year:        p.year || null,
        navModes:    p.nav_modes || null,
        category:    p.category || null,
        isMil:       !!(p.mil || p.dbFlags === 1),
        // posTime: actual position measurement time (seconds). Derived from the
        // source's own clock to avoid server-clock vs feeder-clock drift issues.
        posTime,
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
 * [Time Series] Helper to ingest raw plane data into SQLite (track_points)
 * Standardizes format, lowercases ICAO24, and filters out corrupted coordinates.
 */
// [v6.0] Ingestion telemetry counters
const ingestionStats = { totalPoints: 0, totalBatches: 0, sessionsCreated: 0, sessionsClosed: 0, lastBatchSize: 0, lastBatchMs: 0 };

const { registerHealthRoutes, DATA_FRESHNESS_THRESHOLDS } = require('./routes/health');
registerHealthRoutes(app, {
    requireAdminAccess, syncLog, accountPool, rawAccounts: _rawAccounts, activeSessions,
    ingestionStats, sourceHealth, apiStats, TrackPoint, FlightSession,
    getMasterStateMap: () => masterStateMap,
    getGlobalPlanesCache: () => globalPlanesCache,
    getCpuUsage: () => _currentCpuUsage,
    backendDir: __dirname,
});

async function ingestTrackPoints(states, timeUnix) {
    if (!states || states.length === 0) return;

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
        // Only registry-resolvable aircraft get sessions and track history.
        // TIS-B/ADS-R targets still render live; they just aren't persisted.
        if (!isRealIcao24(String(p.icao24 || '').toLowerCase())) continue;

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
            session = { sessionId: newSessionId, callsign, lastSeen: now, startTime: timeUnix, onGround, groundIdleSince: null, groundCounter: 0, airborneCounter: 0 };
            activeSessions.set(icao24, session);

            // Invalidate stale route cache for this callsign so the next sidebar click
            // fetches a fresh route (prevents showing the previous flight's Arrived route).
            if (callsign && callsign !== 'N/A') {
                Route.invalidate(callsign);
            }

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

        // posTime: actual position measurement time (seconds), computed from the
        // source API's own clock (sourceNow - seen_pos). Falls back to server
        // ingest time if the source didn't provide posTime.
        const posTime = (p.posTime != null) ? p.posTime : timeUnix;

        if (lsp) {
            // [Staleness guard] Skip if this position is more than 10s older than the
            // last point we already stored. Prevents feeder/lol interleaving from writing
            // backwards-in-time positions that create zigzag artifacts on the trail.
            if (lsp.posTs != null && posTime < lsp.posTs - 10) continue;

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
            ts: timeUnix,
            posTs: posTime,  // actual measurement time for future staleness checks
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
            squawk: p.squawk || null,
            callsign: callsign !== 'N/A' ? callsign : null,
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
                console.error('[INGEST] TrackPoint write error:', err.message);
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

    // Push new track points to any WS clients that have that plane selected
    for (const tp of batchTrackPoints) {
        broadcastTrackPoint(tp.icao24, [
            timeUnix,       // Unix seconds (integer — tp.timestamp is a Date object)
            tp.lat,
            tp.lng,
            tp.altitude,
            tp.heading,
            tp.velocity
        ]);
    }

    // Update telemetry
    ingestionStats.totalPoints += batchTrackPoints.length;
    ingestionStats.totalBatches++;
    ingestionStats.lastBatchSize = batchTrackPoints.length;
    ingestionStats.lastBatchMs = Math.round(performance.now() - batchStart);
}

// ── v11.0 Three-Tier Polling Engine ───────────────────────────────────────
// Replaces the old single-loop fetchGlobalPlanes().
// Three independent setIntervals run concurrently:
//   fetchGlobalBaseline    — 5s   adsb.lol primary, adsb.fi-snap fallback
//   fetchViewportOverlay   — 5s   re-api.adsb.lol + al-point, fallback adsb.fi v3
//   fetchSpecialCategories — 60s  military + LADD

// ── Tier 1: Global Baseline ────────────────────────────────────────────────
// Primary: adsb.lol (no quota, 5s interval)
// Fallback: adsb.fi snapshot (if adsb.lol fails)
let _baselineRunning = false;

async function fetchGlobalBaseline() {
    if (_baselineRunning) return;
    _baselineRunning = true;
    const t0 = performance.now();

    try {
        // Both sources fire in parallel every cycle — hot standby.
        // adsb.lol is preferred; adsb.fi data is ready immediately if lol fails,
        // with zero additional delay (no sequential fallback gap).
        const [lolR, fiR] = await Promise.allSettled([
            cbOpen('adsb.lol')
                ? Promise.reject(new Error('CB open'))
                : fetch('https://api.adsb.lol/v2/lat/0/lon/0/dist/99999', {
                      headers: { 'User-Agent': 'AEROSTRAT/12.0' },
                      signal: AbortSignal.timeout(8000),
                  }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),

            cbOpen('adsb.fi-snap')
                ? Promise.reject(new Error('CB open'))
                : fetch('https://opendata.adsb.fi/api/v2/snapshot', {
                      headers: { 'User-Agent': 'AEROSTRAT/12.0' },
                      signal: AbortSignal.timeout(10000),
                  }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
        ]);

        let lolStates = [];
        let fiStates  = [];

        if (lolR.status === 'fulfilled') {
            lolStates = (lolR.value.ac || []).map(p => normalizeAcRecord(p, lolR.value.now))
                .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
            cbReset('adsb.lol', lolStates.length, Math.round(performance.now() - t0));
        } else {
            const msg = lolR.reason?.message || '';
            if (msg === 'CB open') logSuppressedSource('adsb.lol');
            else {
                if (msg.includes('429') || msg.includes('503')) cbTrip('adsb.lol');
                logger.warn('SYNC', `adsb.lol failed: ${msg}`);
            }
        }

        if (fiR.status === 'fulfilled') {
            fiStates = (fiR.value.ac || []).map(p => normalizeAcRecord(p, fiR.value.now))
                .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
            cbReset('adsb.fi-snap', fiStates.length, Math.round(performance.now() - t0));
        } else {
            const msg = fiR.reason?.message || '';
            if (msg === 'CB open') logSuppressedSource('adsb.fi-snap');
            else {
                if (msg.includes('403')) cbTrip('adsb.fi-snap', 60 * 60_000);
                else if (msg.includes('429')) cbTrip('adsb.fi-snap');
                logger.warn('SYNC', `adsb.fi-snap failed: ${msg}`);
            }
        }

        // Prefer adsb.lol; fall back to adsb.fi instantly (data already fetched)
        let states = lolStates.length > 0 ? lolStates : fiStates;
        let source = lolStates.length > 0 ? 'adsb.lol' : (fiStates.length > 0 ? 'adsb.fi-snap' : '');

        // Tier 1c: both ADS-B aggregators came back empty — fall back to OpenSky.
        // Credit-metered, so it throttles itself rather than following the 5s loop.
        if (states.length === 0) {
            const osStates = await fetchOpenSkyBaselineFallback();
            if (osStates.length > 0) {
                states = osStates;
                source = 'opensky';
            }
        }

        if (states.length === 0) {
            logger.warn('SYNC', 'Global baseline: all sources failed — using stale cache');
            globalPlanesCache.stale = true;
            return;
        }

        // OpenSky carries no typecode/registration/operator — merge so the
        // enrichment already collected from adsb.lol survives the outage.
        mergeStates(states, source === 'opensky' ? 'merge' : 'upsert');
        pruneAndBroadcast();
        logger.info('SYNC', `✅ Global baseline: ${states.length} planes | source: ${source} | ${Math.round(performance.now()-t0)}ms`);

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
            const states = (alR.value.ac || []).map(p => normalizeAcRecord(p, alR.value.now))
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
            const states = (reR.value.aircraft || []).map(p => normalizeAcRecord(p, reR.value.now))
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
                vpStates = (data.ac || []).map(p => normalizeAcRecord(p, data.now))
                    .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
                vpSources.push('adsb.fi-v3');
                cbReset('adsb.fi-v3', vpStates.length, Math.round(performance.now() - t0));
            } catch (e) {
                if (e.message.includes('403')) cbTrip('adsb.fi-v3', 60 * 60_000);
                else if (e.message.includes('429')) cbTrip('adsb.fi-v3');
            }
        }

        if (vpStates.length > 0) {
            mergeStates(vpStates, 'merge');  // merge: preserve existing desc/year/typecode
            pruneAndBroadcast();
            // Ingest the post-arbitration positions from masterStateMap, not
            // the raw vpStates — mergeStates() may have rejected a stale or
            // implausible position for a given aircraft this cycle, and
            // ingesting vpStates directly bypassed that check entirely,
            // writing the same backend-vs-backend position conflicts that
            // caused live-map jitter straight into permanent track history.
            const arbitratedVpStates = vpStates
                .map(p => masterStateMap.get(p.icao24))
                .filter(Boolean);
            ingestTrackPoints(arbitratedVpStates, Math.floor(Date.now() / 1000)).catch(() => {});
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
            .map(p => {
                // Defense in depth against the same class of bug this cache
                // already got polluted by once — never persist a signal-source
                // label as if it were a typecode, regardless of how p.typecode
                // ended up set this cycle.
                const typecode = isValidTypecode(p.typecode) ? p.typecode : null;
                return {
                    updateOne: {
                        filter: { $or: [{ icao24: p.icao24 }, { hex: p.icao24 }] },
                        update: {
                            $set: Object.fromEntries([
                                ['icao24', p.icao24], ['hex', p.icao24],
                                p.registration && ['registration', p.registration],
                                typecode       && ['typecode',      typecode],
                                typecode       && ['type_code',     typecode],
                                p.operator     && ['operator',      p.operator],
                                p.operator     && ['airline',       p.operator],
                                p.description  && ['description',   p.description],
                                p.year         && ['year',          p.year],
                            ].filter(Boolean)),
                        },
                        upsert: true,
                    },
                };
            });
        if (writebackOps.length > 0) Aircraft.bulkWrite(writebackOps, { ordered: false })
            .catch(err => logger.warn('SYNC', `Aircraft writeback failed: ${err.message}`));

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
            let tc = isValidTypecode(p.typecode) ? p.typecode : null;
            if (!tc && isValidTypecode(metaMap.get(k))) tc = metaMap.get(k);
            if (!tc && aircraftMetadataIndex?.has(k)) {
                const idxTc = aircraftMetadataIndex.get(k);
                if (isValidTypecode(idxTc)) tc = idxTc;
                if (p.callsign && p.callsign !== 'UNKNOWN') triggerBackgroundResolution(k, p.callsign);
            }
            if (tc) { p.typecode = tc; enrichedCount++; }
            const reg = regMap.get(k);
            if (reg) {
                if (!p.registration && reg.registration) p.registration = reg.registration;
                if (!p.operator && (reg.owner || reg.operatorCallsign))
                    p.operator = reg.owner || reg.operatorCallsign;
            }
            // Mictronics has 73%/76%/99.9% operator/model/registration coverage
            // (vs the in-memory AircraftStore's ~4% operator coverage above,
            // which only ever gets populated from the live ADS-B ownOp field).
            // This was previously only queried on a single-plane detail click
            // (getCompleteDetailsInternal) — every plane in the map-wide bbox
            // view showed no airline at all. A lookup here is a local indexed
            // SQLite read (~6μs each; 7,000 planes ≈ 44ms measured), nowhere
            // near expensive enough to justify skipping it map-wide.
            if (!p.operator || !p.model || !isValidTypecode(p.typecode)) {
                const mict = MictronicsDb.lookup(k);
                if (mict) {
                    if (!p.operator && mict.operator) p.operator = mict.operator;
                    if (!p.model && mict.model) p.model = mict.model;
                    if (!isValidTypecode(p.typecode) && isValidTypecode(mict.typecode)) p.typecode = mict.typecode;
                }
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

// fetchGlobalPlanes() removed — replaced by v11.0 three-tier engine above.
async function fetchGlobalPlanes() {
    return; // dead — three-tier engine replaced this entirely
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
setInterval(fetchGlobalBaseline,    5_000);    // adsb.lol primary (5s), adsb.fi fallback
setInterval(fetchViewportOverlay,    5_000);   // viewport high-frequency overlay
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

// [Surgical Patch] 極簡化 BBox 路由：整合 Aircraft store 飛機情報融合
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
        res.json({ hex, source: 'error_fallback', trace: [], error: 'Internal server error' });
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

// [REMOVED] saveMetadataCache is no longer needed with the Aircraft store

app.get('/api/metadata/:icao24', async (req, res) => {
    const icao24 = req.params.icao24.toLowerCase();
    if (!isValidIcao24(icao24)) return res.status(400).json({ error: 'Invalid ICAO24 format' });

    // helper: attach OpenAP performance data if type code is known
    function attachOpenAP(data) {
        const tc = (data?.typecode || data?.type_code || '').toUpperCase();
        if (!tc || !openapPerfDB[tc]) return data;
        return { ...data, performance: openapPerfDB[tc] };
    }

    // 1. 優先檢查靜態字典 (Static First)
    if (aircraftStaticDB[icao24]) {
        return res.json(attachOpenAP({ ...aircraftStaticDB[icao24], fromStatic: true }));
    }

    try {
        // 2. 檢查快取
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
            return res.json(attachOpenAP(dbAircraft));
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

        // 存入 Aircraft store
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

    // 過濾靜態字典中已有的
    const filteredIcaos = icao24List.filter(id => !aircraftStaticDB[id.toLowerCase()]);
    if (filteredIcaos.length === 0) return res.json({ fetched: 0 });

    try {
        // 從 Aircraft store 找出已有的
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

        console.log(`${getTime()} 📦 [BATCH] Fetched ${fetched}/${toFetch.length} metadata to cache`);
        res.json({ fetched: fetched, requested: toFetch.length });
    } catch (err) {
        console.error('❌ [BATCH ERROR]', err.message);
        res.status(500).json({ fetched: 0, error: 'Internal server error' });
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
const SCHEDULES_STATIC_FILE   = path.join(__dirname, 'data', 'schedules_static.json');
const GLOBAL_AIRPORTS_FILE    = path.join(__dirname, 'data', 'processed', 'airports_global.json');
const GLOBAL_AIRLINES_FILE    = path.join(__dirname, 'data', 'processed', 'airlines.json');
const OPENFLIGHTS_GLOBAL_FILE = path.join(__dirname, 'data', 'processed', 'schedules_global.json');
const OPENFLIGHTS_PREFIX_FILE = path.join(__dirname, 'data', 'processed', 'airline_prefixes.json');
const OPENAP_PERF_FILE        = path.join(__dirname, 'data', 'openap', 'aircraft_perf.json');

let routesDatabase = {};
let localRoutesDB = {};
let schedulesStaticDB = {};
let globalAirportsDB = {};
let globalAirlinesDB = {};
let openflightsGlobalDB = {};   // callsign → {dep, arr}
let openflightsPrefixDB = {};   // airline IATA prefix → [{dep,arr}]
let openapPerfDB = {};          // ICAO type code → performance params

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
        if (fs.existsSync(OPENFLIGHTS_GLOBAL_FILE)) {
            openflightsGlobalDB = JSON.parse(fs.readFileSync(OPENFLIGHTS_GLOBAL_FILE, 'utf8'));
            console.log(`🌍 [OPENFLIGHTS] Loaded ${Object.keys(openflightsGlobalDB).length} exact callsign routes`);
        }
        if (fs.existsSync(OPENFLIGHTS_PREFIX_FILE)) {
            openflightsPrefixDB = JSON.parse(fs.readFileSync(OPENFLIGHTS_PREFIX_FILE, 'utf8'));
            console.log(`🌍 [OPENFLIGHTS] Loaded ${Object.keys(openflightsPrefixDB).length} airline prefix networks`);
        }
        if (fs.existsSync(OPENAP_PERF_FILE)) {
            openapPerfDB = JSON.parse(fs.readFileSync(OPENAP_PERF_FILE, 'utf8'));
            console.log(`✈️ [OPENAP] Loaded ${Object.keys(openapPerfDB).length} aircraft performance profiles`);
        }
    } catch (e) {
        console.error('❌ [GLOBAL DATA ERROR] Failed to load global JSON files:', e.message);
    }
}

// [OPT 1.1] 機場清單快取變數與函式——必須在 loadGlobalData()/buildAirportGrid() 之前宣告
let _cachedAirportList = null;
let _cachedAirportListETag = '';

async function buildAirportListCache() {
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
// Feed airports into staticMaps so flightController route resolution can resolve ICAO→IATA and names
staticMaps.loadAirports(Object.values(globalAirportsDB));
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
    // Feed routes into staticMaps so flightController fetchLocalOSINTRoute can resolve callsign→airports
    const combinedRoutes = [
        ...Object.entries(localRoutesDB).map(([cs, pair]) => ({ callsign: cs, originIata: pair[0], destinationIata: pair[1] })),
        ...Object.entries(schedulesStaticDB).map(([cs, r]) => ({ callsign: cs, originIata: r.dep, destinationIata: r.arr })),
    ];
    if (combinedRoutes.length > 0) {
        staticMaps.loadRoutes(combinedRoutes);
        console.log(`🗺️ [ROUTE DICT] Seeded ${combinedRoutes.length} routes into RouteDictionary`);
    }
} catch (e) {
    console.error('❌ [ROUTE DB] Failed to load route JSONs:', e.message);
}

// [REMOVED] routesDatabase is migrated to RouteStore

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
        // 1. Check Global Database (Fast Key Lookup)
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
        // 2. 緩存資料獲取（優先作為首張）
        let cachedPhoto = null;
        const aircraft = await Aircraft.findOne({ icao24: icao24.toLowerCase() });
        if (aircraft?.photoData?.url) {
            cachedPhoto = {
                thumbnail: { src: aircraft.photoData.thumbnail },
                thumbnail_large: { src: aircraft.photoData.url },
                photographer: aircraft.photoData.photographer,
                link: aircraft.photoData.link,
                source: 'cache'
            };
        }

        // 3. 抓取外部 API — 優先用 reg（hex 永遠回空）
        let freshPhotos = [];

        // [A] Planespotters — reg 優先，有 reg 直接用；否則才試 hex
        const psHeaders = { 'User-Agent': 'AEROSTRAT/5.0 (flight-tracking)' };
        if (reg && reg !== 'N/A') {
            try {
                const regRes = await fetch(
                    `https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`,
                    { headers: psHeaders, signal: AbortSignal.timeout(5000) }
                );
                if (regRes.ok) {
                    const data = await regRes.json();
                    if (data.photos?.length) freshPhotos = data.photos;
                }
            } catch (_) {}
        }
        if (freshPhotos.length === 0) {
            try {
                const hexRes = await fetch(
                    `https://api.planespotters.net/pub/photos/hex/${icao24}`,
                    { headers: psHeaders, signal: AbortSignal.timeout(5000) }
                );
                if (hexRes.ok) {
                    const data = await hexRes.json();
                    if (data.photos?.length) freshPhotos = data.photos;
                }
            } catch (_) {}
        }

        // [B] airport-data.com fallback — 無 www（SSL 憑證只綁 apex domain）
        if (freshPhotos.length < 2 && reg && reg !== 'N/A') {
            try {
                const adRes = await fetch(
                    `https://airport-data.com/api/ac_thumb.json?r=${encodeURIComponent(reg)}&n=3`,
                    { headers: { 'User-Agent': 'AEROSTRAT/5.0' }, signal: AbortSignal.timeout(4000) }
                );
                if (adRes.ok) {
                    const adData = await adRes.json();
                    if (adData.status === 200 && Array.isArray(adData.data)) {
                        for (const p of adData.data) {
                            if (!p.image) continue;
                            freshPhotos.push({
                                thumbnail:       { src: p.image },
                                thumbnail_large: { src: p.image },
                                photographer: p.photographer || 'airport-data.com',
                                link: p.link || p.image,
                                source: 'airport-data'
                            });
                        }
                    }
                }
            } catch (_) {}
        }

        // 4. 合併與去重 (限量 3 張，優先使用高品質的 Fresh Data)
        let finalPhotos = [];
        const seenUrls = new Set();
        
        // Helper to add unique photos
        const addPhoto = (p) => {
            if (finalPhotos.length >= 3) return;
            const url = p.thumbnail_large?.src || p.thumbnail?.src || p.link;
            if (url && !seenUrls.has(url)) {
                finalPhotos.push({
                    thumbnail: { src: p.thumbnail?.src || url },
                    thumbnail_large: { src: url },
                    photographer: p.photographer,
                    link: p.link,
                    source: p.source || 'api'
                });
                seenUrls.add(url);
            }
        };

        // 優先從 Fresh API 抓取 (通常畫質較新)
        freshPhotos.forEach(addPhoto);
        
        // 若不足 3 張，補充 cachedPhoto
        if (cachedPhoto) addPhoto(cachedPhoto);

        // [DB CACHE Updates] 5. 持續更新快取資訊 (僅針對首張最優圖)
        if (finalPhotos.length > 0 && (!cachedPhoto)) {
            const p = finalPhotos[0];
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
        res.json(finalPhotos);

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
        // [DB CACHE] 1. 優先從 RouteStore 讀取
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
                source: 'cache'
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
        res.status(500).json({ error: "Internal server error" });
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
        if (openflightsGlobalDB[cs]) {
            route = { dep: openflightsGlobalDB[cs].dep, arr: openflightsGlobalDB[cs].arr };
            matchSource = 'openflights';
            break;
        }

        // Route store cache — skip spatial_inference entries (they are position-guesses, not real routes)
        const dbRoute = await Route.findOne({ callsign: cs });
        if (dbRoute && dbRoute.source !== 'spatial_inference' && dbRoute.departureAirport && dbRoute.arrivalAirport) {
            route = { dep: dbRoute.departureAirport, arr: dbRoute.arrivalAirport };
            matchSource = 'route_cache';
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

    // 2. In-memory short-term cache (noData results use shorter TTL so they retry sooner)
    const cached = routeCache.get(icao24);
    if (cached) {
        const ttl = cached.data?.noData ? 120000 : ROUTE_CACHE_TTL; // noData: 2 min, good: 30 min
        if (Date.now() - cached.timestamp < ttl) {
            return res.json(cached.data);
        }
    }

    try {
        // --- Layer 3a: adsbdb.com (free, no quota) ---
        if (cleanCallsign) {
            try {
                const adsbdbRes = await fetch(`https://api.adsbdb.com/v0/callsign/${cleanCallsign}`, {
                    headers: { 'User-Agent': 'AEROSTRAT/12.0' },
                    signal: AbortSignal.timeout(4000),
                });
                if (adsbdbRes.ok) {
                    const adsbdbData = await adsbdbRes.json();
                    const fl = adsbdbData?.response?.flightroute;
                    if (fl?.origin?.icao_code && fl?.destination?.icao_code) {
                        console.log(`✅ [ADSBDB] Route for ${cleanCallsign}: ${fl.origin.icao_code} → ${fl.destination.icao_code}`);
                        const result = {
                            icao24, callsign: cleanCallsign,
                            departureAirport: fl.origin.icao_code,
                            arrivalAirport: fl.destination.icao_code,
                            source: 'adsbdb',
                        };
                        routeCache.set(icao24, { data: result, timestamp: Date.now() });
                        Route.findOneAndUpdate(
                            { callsign: cleanCallsign },
                            { $set: { departureAirport: fl.origin.icao_code, arrivalAirport: fl.destination.icao_code, source: 'adsbdb', lastUpdated: new Date() } },
                            { upsert: true }
                        ).catch(() => null);
                        return res.json(result);
                    }
                }
            } catch (_) { /* adsbdb timeout — continue */ }
        }

        // --- Layer 3b: AirLabs Routes DB (1000 req/month free) ---
        const AIRLABS_KEY = process.env.AIRLABS_API_KEY;
        if (cleanCallsign && AIRLABS_KEY) {
            try {
                const alRes = await fetch(
                    `https://airlabs.co/api/v9/flights?flight_icao=${cleanCallsign}&api_key=${AIRLABS_KEY}`,
                    { signal: AbortSignal.timeout(5000) }
                );
                if (alRes.ok) {
                    const alData = await alRes.json();
                    const fl = alData?.response?.[0];
                    const dep = fl?.dep_icao || fl?.dep_iata;
                    const arr = fl?.arr_icao || fl?.arr_iata;
                    if (dep && arr) {
                        console.log(`✅ [AIRLABS] Route for ${cleanCallsign}: ${dep} → ${arr}`);
                        const result = { icao24, callsign: cleanCallsign, departureAirport: dep, arrivalAirport: arr, source: 'airlabs' };
                        routeCache.set(icao24, { data: result, timestamp: Date.now() });
                        Route.findOneAndUpdate(
                            { callsign: cleanCallsign },
                            { $set: { departureAirport: dep, arrivalAirport: arr, source: 'airlabs', lastUpdated: new Date() } },
                            { upsert: true }
                        ).catch(() => null);
                        return res.json(result);
                    }
                }
            } catch (_) { /* airlabs timeout — continue */ }
        }

        // --- Layer 3c: AeroDataBox real-time route lookup ---
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
                    // Do NOT persist spatial_inference to RouteStore — avoids poisoning the route cache
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
        // --- Layer 1: RouteStore Cache (DB HIT) ---
        const dbRoute = await Route.findOne({ callsign });
        if (dbRoute && dbRoute.departureAirport && dbRoute.arrivalAirport) {
            console.log(`🎯 [DB HIT] Found complete route for ${callsign}: ${dbRoute.departureAirport} -> ${dbRoute.arrivalAirport}`);
            return res.json({
                callsign,
                departureAirport: dbRoute.departureAirport,
                arrivalAirport: dbRoute.arrivalAirport,
                source: 'route_cache',
                lastUpdated: dbRoute.lastUpdated
            });
        }
        // Partial route (e.g., spatial_inference with dep only) — continue to try enriching

        console.log(`⚡ [DB MISS] No route cached for ${callsign}. Escalating to API/Mock...`);

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

        // --- Layer 3: adsbdb.com fallback (free, community-sourced) ---
        if (!externalData) {
            try {
                const adsbdbRes = await fetch(`https://api.adsbdb.com/v0/callsign/${callsign}`, {
                    headers: { 'User-Agent': 'AEROSTRAT/12.0' },
                    signal: AbortSignal.timeout(4000),
                });
                if (adsbdbRes.ok) {
                    const adsbdbData = await adsbdbRes.json();
                    const fl = adsbdbData?.response?.flightroute;
                    if (fl?.origin?.icao_code && fl?.destination?.icao_code) {
                        externalData = { dep: fl.origin.icao_code, arr: fl.destination.icao_code, source: 'adsbdb' };
                    }
                }
            } catch (_) { /* timeout — skip */ }
        }

        if (externalData) {
            // --- Layer 4: Persistence (SAVE TO DB) ---
            console.log(`💾 [DB SAVE] Persisting new route for ${callsign} to route store...`);
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
        res.json({ callsign, noData: true, error: 'Internal server error' });
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
 * Fetch track for an aircraft — always session-scoped to prevent mixing flights.
 *
 * Resolution order:
 *   1. activeSessions Map (in-memory, O(1)) → sessionId + startTime
 *   2. SessionStore.findLatestActiveByIcao24() → latest ACTIVE or most-recent DB session
 *   3. TrackStore.findBySessionId(sessionId) → session-isolated track points
 *   4. Session-bounded SQLite fallback (session_id = ?) if TrackStore returns < 5 pts
 *   5. OpenSky historical augmentation filtered to session start time
 *
 * Cache key: `s_${sessionId}` — different keys across flights prevent stale data
 * from a previous flight being served for a new session.
 */
async function fetchTracksInternal(icao24) {
    const icao = icao24.toLowerCase();

    // ── 1. Resolve current session — in-memory first (O(1)), then DB ───────
    let sessionId        = null;
    let sessionStartUnix = null;

    const memSession = activeSessions.get(icao);
    if (memSession) {
        sessionId        = memSession.sessionId;
        sessionStartUnix = memSession.startTime; // Unix seconds, set at session creation
    } else {
        // Aircraft not currently active — query DB for its latest session.
        // Guard: only accept ACTIVE sessions, or COMPLETED sessions updated
        // within the last 2 hours.  Sessions older than that belong to a
        // previous flight and must NOT contaminate the current view.
        const dbSession = await FlightSession.findLatestActiveByIcao24(icao);
        if (dbSession) {
            const sessionAgeMs = dbSession.updatedAt
                ? Date.now() - dbSession.updatedAt.getTime()
                : Infinity;
            const MAX_COMPLETED_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

            if (dbSession.status === 'ACTIVE' || sessionAgeMs < MAX_COMPLETED_AGE_MS) {
                sessionId        = dbSession.sessionId;
                sessionStartUnix = dbSession.startTime
                    ? Math.floor(dbSession.startTime.getTime() / 1000)
                    : null;
            } else {
                // Stale COMPLETED session — belongs to a previous flight, skip it
                logger.debug('TRACK', `${icao24}: skipping stale ${dbSession.status} session (${Math.round(sessionAgeMs / 3600000)}h old), returning empty path`);
            }
        }
    }

    // ── 2. Session-scoped cache check ───────────────────────────────────────
    const cacheKey = sessionId ? `s_${sessionId}` : `i_${icao}`;
    const cached = trackCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < TRACK_CACHE_TTL)) {
        return cached.data;
    }

    try {
        // ── 3. Primary fetch — current flight leg across all sessions ──────────
        // Fetch all 24h points for this ICAO, then find the start of the current
        // flight leg (last ground stop before the current airborne segment).
        // This joins sessions split by ADS-B ocean gaps or server restarts.
        let localPoints = [];
        {
            const sqliteDb = require('./db/sqlite');
            const cutoff24h = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

            // ── Determine query cutoff ──────────────────────────────────────────
            // Key question: is the current session a NEW FLIGHT (hard cutoff)
            // or a CONTINUATION after an oceanic ADS-B coverage gap (use 24h)?
            //
            // Strategy: peek at the last known state just before this session.
            //   • Last state = on_ground OR altitude < 5000ft  → new flight (hard cutoff)
            //   • Last state = cruise altitude (≥ 15000ft)     → oceanic gap, same flight
            //   • No previous state in DB                       → treat as new (hard cutoff)
            let queryCutoff = cutoff24h;

            if (sessionStartUnix) {
                const lookbackStart = Math.max(cutoff24h, sessionStartUnix - 4 * 3600);
                const prevState = sqliteDb.prepare(
                    'SELECT altitude, on_ground, ts FROM track_points WHERE icao24 = ? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 1'
                ).get(icao, lookbackStart, sessionStartUnix - 60);

                let prevWasGround = !prevState
                    || prevState.on_ground
                    || (prevState.altitude != null && prevState.altitude < 5000);

                // Extra check: even when prevState was at cruise altitude, look for any
                // on_ground evidence BETWEEN prevState and this session start.
                // If the aircraft touched down between those two points, this is a new
                // flight regardless of what altitude the last tracked point showed.
                if (!prevWasGround && prevState) {
                    const anyGndBetween = sqliteDb.prepare(
                        'SELECT 1 FROM track_points WHERE icao24 = ? AND ts > ? AND ts < ? AND on_ground = 1 LIMIT 1'
                    ).get(icao, prevState.ts, sessionStartUnix - 60);
                    if (anyGndBetween) {
                        prevWasGround = true;
                    }
                }

                if (prevWasGround) {
                    // Confirmed new flight: hard cutoff at session start
                    queryCutoff = Math.max(cutoff24h, sessionStartUnix - 600);
                }
                // else: cruise altitude before session, no ground evidence → oceanic gap
                // → queryCutoff stays at cutoff24h, walk-backward will handle it
            }

            const allRows = sqliteDb.prepare(
                'SELECT ts, lat, lng, altitude, velocity, heading, on_ground, session_id, icao24, callsign FROM track_points WHERE icao24 = ? AND ts >= ? ORDER BY ts ASC LIMIT 20000'
            ).all(icao.toLowerCase(), queryCutoff);

            if (allRows.length > 0) {
                // [v11.4] Walk-backward with two boundaries:
                //   1. ground→airborne transition = definitive takeoff
                //   2. callsign change = different flight (if callsign data available)
                // Oceanic ADS-B gaps (no data for hours) are NOT flight boundaries.
                let flightStartIdx = 0;
                const lastCallsign = allRows[allRows.length - 1].callsign || null;

                for (let i = allRows.length - 1; i >= 1; i--) {
                    const r    = allRows[i];
                    const prev = allRows[i - 1];

                    // 1. Ground → airborne = definitive takeoff
                    if (!r.on_ground && prev.on_ground) {
                        flightStartIdx = i;
                        break;
                    }

                    // 2. Callsign change = different flight (requires callsign column populated)
                    if (lastCallsign && prev.callsign && prev.callsign !== lastCallsign) {
                        flightStartIdx = i;
                        logger.debug('TRACK', `${icao24}: callsign change ${prev.callsign}→${lastCallsign} at idx ${i}`);
                        break;
                    }

                    // 3. Altitude-gap heuristic: detects landings without on_ground data.
                    //    Two patterns — both indicate a ground stop occurred during the gap:
                    //
                    //    Pattern A: approach-low → gap > 45min → departure-higher
                    //      prev altitude < FL100 (10000ft) AND r altitude > prev + 2000ft
                    //      e.g. prev=900ft (ILS) → 94min gap → r=4975ft (climb after takeoff)
                    //
                    //    Pattern B: any cruise → very long gap (>4h) → very-low departure
                    //      Gap so long that a ground stop is almost certain,
                    //      and r is at typical initial-climb altitude (<5000ft).
                    //      e.g. prev=34025ft (cruise, ADS-B lost) → 990min → r=775ft (climbing)
                    //
                    //    Altitude unit: feet (ADS-B standard in DB).
                    const gapSec = r.ts - prev.ts;
                    if (gapSec > 20 * 60) {
                        const prevAlt = prev.altitude ?? 99999;
                        const rAlt    = r.altitude   ?? 0;
                        // Pattern A: low approach → gap ≥ 45min → departure higher
                        const isPatternA = gapSec > 45 * 60 && prevAlt < 10000 && rAlt > prevAlt + 2000;
                        // Pattern A-fast: very low approach → short gap (20-45min) → departure
                        // Catches quick turnarounds where ground stop < 45min.
                        const isPatternAfast = gapSec <= 45 * 60 && prevAlt < 3000 && rAlt > prevAlt + 1500;
                        // Pattern B: gap > 4h AND post-gap altitude very low (just departed)
                        const isPatternB = gapSec > 4 * 3600 && rAlt < 5000;
                        // Pattern D: cruise → long gap (>1h) → low departure (<5000ft)
                        // Aircraft was at cruise, disappeared from coverage (landed somewhere),
                        // now reappears at low altitude = just took off from destination.
                        // Distinct from oceanic gap where both sides stay at cruise.
                        const isPatternD = gapSec > 60 * 60 && prevAlt > 10000 && rAlt < 5000;
                        if (isPatternA || isPatternAfast || isPatternB || isPatternD) {
                            flightStartIdx = i;
                            const pat = isPatternA ? 'A' : isPatternAfast ? 'A-fast' : isPatternD ? 'D' : 'B';
                            logger.debug('TRACK', `${icao24}: alt-gap boundary [Pattern ${pat}] at idx ${i} (prev=${Math.round(prevAlt)}ft → ${Math.round(gapSec/60)}min → r=${Math.round(rAlt)}ft)`);
                            break;
                        }
                    }
                }

                const flightRows = allRows.slice(flightStartIdx);
                localPoints = flightRows.map(r => ({
                    sessionId: r.session_id, icao24: r.icao24,
                    timestamp: new Date(r.ts * 1000),
                    lat: r.lat, lng: r.lng, altitude: r.altitude,
                    velocity: r.velocity, heading: r.heading, onGround: !!r.on_ground,
                }));
                logger.debug('TRACK', `${icao24}: ${localPoints.length} pts for current leg (total 24h: ${allRows.length})`);
            } else if (sessionId) {
                // Fallback: session-scoped query if icao-wide returns nothing
                const fallbackRows = sqliteDb.prepare(
                    'SELECT * FROM track_points WHERE session_id = ? ORDER BY ts ASC LIMIT 15000'
                ).all(sessionId);
                localPoints = fallbackRows.map(r => ({
                    sessionId: r.session_id, icao24: r.icao24,
                    timestamp: new Date(r.ts * 1000),
                    lat: r.lat, lng: r.lng, altitude: r.altitude,
                    velocity: r.velocity, heading: r.heading, onGround: !!r.on_ground,
                }));
            }
        }

        // ── 5. Build path array — deduplicate consecutive identical coordinates ─
        // Note: OpenSky historical augmentation has been removed. It mixed MLAT
        // positions (accuracy ~km) into clean ADS-B tracks from adsb.fi/adsb.lol
        // (~10m), causing visible path deviations. Local ADS-B data is authoritative.
        const rawPath = localPoints.map(pt => [
            Math.floor(pt.timestamp.getTime() / 1000),
            pt.lat, pt.lng, pt.altitude || 0, pt.heading != null ? pt.heading : -1, pt.velocity || 0, pt.onGround ? 1 : 0
        ]);
        const path = rawPath.filter((pt, i) => {
            if (i === 0) return true;
            const prev = rawPath[i - 1];
            return pt[1] !== prev[1] || pt[2] !== prev[2];
        });

        const result = { icao24, sessionId, path };
        // Don't cache empty results — retry on next click so fresh data can appear
        if (path.length > 0) {
            trackCache.set(cacheKey, { data: result, timestamp: Date.now() });
        }
        return result;

    } catch (e) {
        logger.error('TRACK', `fetchTracksInternal failed for ${icao24}: ${e.message}`);
        return { icao24, sessionId, path: [], noData: true, error: e.message };
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
                pt.heading != null ? pt.heading : -1,
                pt.velocity || 0,
                pt.onGround ? 1 : 0
            ])
        });
    } catch (err) {
        res.status(500).json({ error: "Internal server error" });
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

    try {
        const sessions = await FlightSession.findAllByIcao24(icao24, req.query.status, limit);

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
        res.status(500).json({ error: "Internal server error" });
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
    syncLog.start('metar');
    try {
        const ids = METAR_AIRPORTS.join(',');
        const url = `https://aviationweather.gov/api/data/metar?ids=${ids}&format=json`;
        logger.info('METAR', `Fetching weather for ${METAR_AIRPORTS.length} airports`);

        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`METAR API HTTP ${response.status}`);

        const data = await response.json();

        const operations = data.map(info => ({
            updateOne: {
                filter: { icaoId: info.icaoId.toUpperCase() },
                update: {
                    $set: {
                        ...info,
                        location: { type: 'Point', coordinates: [parseFloat(info.lon), parseFloat(info.lat)] },
                        lastUpdated: new Date()
                    }
                },
                upsert: true
            }
        }));

        if (operations.length > 0) {
            await Metar.bulkWrite(operations, { ordered: false });
        }

        logger.info('METAR', `Updated ${data.length} airport weather records`);
        syncLog.success('metar', `${data.length} airports`);
    } catch (error) {
        logger.error('METAR', `Fetch error: ${error.message}`);
        syncLog.fail('metar', error.message);
    }
}

// 啟動時啟動定時器
fetchMetarData(); // 立即執行一次

// 每小時定時更新
setInterval(fetchMetarData, METAR_TTL);

app.get('/api/metar', async (req, res) => {
    try {
        const icao = req.query.icao;
        if (icao) {
            const found = await Metar.findOne({ icaoId: icao.toUpperCase() });
            return res.json(found || { error: 'Airport not found' });
        }
        const all = await Metar.find({});
        res.json(all);
    } catch (err) {
        res.status(500).json({ error: "Internal server error" });
    }
});
// ── API 404 firewall — must stay last among /api/* routes ──────────────────



app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});


// ==========================================
// 自動化資料庫引擎 (Background Auto-Sync)
// ==========================================
async function syncSchedulesDatabase() {
    const JOB = 'schedules';
    logger.info('SCHEDULES', 'Daily sync starting...');
    syncLog.start(JOB);
    try {
        const SCHEDULES_URL = 'https://raw.githubusercontent.com/LiaoCho/flight-data-source/main/schedules_latest.json';
        logger.info('SCHEDULES', `Downloading from ${SCHEDULES_URL}`);

        const response = await fetch(SCHEDULES_URL, { signal: AbortSignal.timeout(60000) });

        if (!response.ok) {
            const msg = `HTTP ${response.status} — source URL may be invalid or unavailable`;
            logger.error('SCHEDULES', `Sync failed: ${msg}`);
            syncLog.fail(JOB, msg);
            return;
        }

        const newData = await response.json();
        await fs.promises.writeFile(SCHEDULES_STATIC_FILE, JSON.stringify(newData, null, 2));
        schedulesStaticDB = newData;

        const count = Object.keys(newData).length;
        logger.info('SCHEDULES', `Sync OK — ${count} routes`);
        syncLog.success(JOB, `${count} routes`);
    } catch (error) {
        logger.error('SCHEDULES', `Sync error: ${error.message}`);
        syncLog.fail(JOB, error.message);
    }
}

// schedules cron disabled — source URL (LiaoCho/flight-data-source) returns 404.
// schedules_static.json contains 34 hand-curated Taiwan routes; edit locally as needed.
// syncSchedulesDatabase() kept for future use when a valid source URL is available.

// TDX 進出港資料：每日凌晨 4 點同步一次（10 機場 × 2 endpoint = 20 req/次，每月 620 req ≈ 0.02 點）
// 主要路由來源已改為 adsbdb.com（免費無限額），TDX 僅作台灣本地班次補充
cron.schedule('0 4 * * *', () => {
    crawlFlightSchedules();
}, {
    timezone: "Asia/Taipei"
});

// ── DB sync timestamps — backed by syncLog (persistent across restarts) ──────
const dbSyncStatus = {
    get vrs()        { return syncLog.get('vrs')        || { status: 'unknown' }; },
    get mictronics() { return syncLog.get('mictronics') || { status: 'unknown' }; },
    get schedules()  { return syncLog.get('schedules')  || { status: 'unknown' }; },
};

// ── VRS Routes Database (daily sync, 03:42 Taiwan time) ──
cron.schedule('42 3 * * *', () => {
    logger.info('VRS', 'Daily sync starting...');
    syncLog.start('vrs');
    syncVrsRoutes(msg => logger.info('VRS', msg))
        .then(r => {
            if (r.success) {
                VrsDb.reload();
                syncLog.success('vrs', `routes updated`);
            } else {
                syncLog.fail('vrs', r.error || 'sync returned success=false');
            }
        })
        .catch(e => {
            logger.error('VRS', `Daily sync failed: ${e.message}`);
            syncLog.fail('vrs', e.message);
        });
}, { timezone: 'Asia/Taipei' });

// ── Mictronics Aircraft Registry (weekly sync, every Sunday 03:17 Taiwan time) ──
// force:true ensures aircraft_types cache is refreshed and existing data is re-synced
cron.schedule('17 3 * * 0', () => {
    logger.info('MICT', 'Weekly sync starting...');
    syncLog.start('mictronics');
    syncMictronics(msg => logger.info('MICT', msg), { force: true })
        .then(r => {
            if (r.skipped) {
                logger.warn('MICT', 'Sync skipped unexpectedly');
                syncLog.fail('mictronics', 'skipped unexpectedly');
            } else {
                logger.info('MICT', `Sync OK — ${r.total || 0} aircraft`);
                syncLog.success('mictronics', `${r.total || 0} aircraft`);
            }
        })
        .catch(e => {
            logger.error('MICT', `Weekly sync failed: ${e.message}`);
            syncLog.fail('mictronics', e.message);
        });
}, { timezone: 'Asia/Taipei' });

// On startup: mark schedules_static as always ok (static file, loaded at boot)
(function markSchedulesOk() {
    const s = syncLog.get('schedules');
    if (!s || !s.lastSuccess) {
        syncLog.success('schedules', 'static file loaded');
    }
})();

// On startup: sync Mictronics if the table is empty OR the last sync is older
// than the same staleness threshold /api/data-freshness uses.
//
// The previous version of this check only asked "does data exist at all" —
// if the table had rows, it just marked syncLog ok and moved on, with no age
// check. That is precisely how this went unnoticed for two months: the
// weekly cron (Sun 03:17 Asia/Taipei) can only fire while the process is
// alive, and this service's systemd unit was broken (wrong working
// directory) for an extended period. Every cron window it missed was silent
// — the table still had 464k old rows, so this check kept reporting "ok".
(async () => {
    try {
        const existing  = MictronicsDb.count();
        const lastSync  = MictronicsDb.lastSyncTime();
        const ageMs     = lastSync ? Date.now() - lastSync * 1000 : Infinity;
        const isStale   = ageMs > DATA_FRESHNESS_THRESHOLDS.mictronics;

        if (existing >= 10000 && !isStale) {
            // Always refresh syncLog to the DB's real synced_at — not just
            // when syncLog has no record — so a syncLog entry that predates
            // an out-of-band resync (e.g. a manual `node scripts/syncMictronics.js`
            // run) doesn't keep reporting the old, stale timestamp forever.
            syncLog.success('mictronics', `${existing} aircraft (last synced ${(ageMs / 86400000).toFixed(1)}d ago)`);
            console.log(`✅ [Mictronics] ${existing.toLocaleString()} aircraft in DB (last sync: ${(ageMs / 86400000).toFixed(1)}d ago)`);
        } else {
            const reason = existing < 10000 ? `table has only ${existing} rows` : `data is ${(ageMs / 86400000).toFixed(1)}d old`;
            console.log(`🛫 [Mictronics] ${reason} — running catch-up sync...`);
            syncLog.start('mictronics');
            const r = await syncMictronics(msg => console.log(msg), { force: true });
            syncLog.success('mictronics', `${r?.total || r?.count || 0} aircraft`);
        }
    } catch (e) {
        console.error(`❌ [Mictronics] Startup check failed: ${e.message}`);
        syncLog.fail('mictronics', e.message);
    }
})();

// On startup: sync VRS routes if routes.db is empty/missing OR stale.
// Same bug as Mictronics above — the old guard (`if lastSuccess, bail`)
// meant a two-month-old success record permanently blocked any catch-up.
(function checkVrsOnStartup() {
    try {
        const lastEntry = syncLog.get('vrs');
        const ageMs = lastEntry?.lastSuccess ? Date.now() - new Date(lastEntry.lastSuccess).getTime() : Infinity;
        const isStale = ageMs > DATA_FRESHNESS_THRESHOLDS.vrs;

        let existingCount = 0;
        try {
            const Database = require('better-sqlite3');
            const vrsDbPath = path.join(__dirname, 'data', 'routes.db');
            if (require('fs').existsSync(vrsDbPath)) {
                const db = new Database(vrsDbPath, { readonly: true });
                existingCount = db.prepare('SELECT COUNT(*) as c FROM routes').get().c;
                db.close();
            }
        } catch (_) { /* routes.db not queryable yet — treat as empty */ }

        if (existingCount > 0 && !isStale) {
            if (!lastEntry?.lastSuccess) syncLog.success('vrs', `${existingCount} routes (existing DB)`);
            logger.info('VRS', `Startup: ${existingCount} routes, ${(ageMs / 86400000).toFixed(1)}d old — within threshold`);
            return;
        }

        logger.info('VRS', `Startup: ${existingCount} routes, ${lastEntry?.lastSuccess ? (ageMs / 86400000).toFixed(1) + 'd old' : 'never synced'} — running catch-up sync...`);
        syncLog.start('vrs');
        syncVrsRoutes(msg => logger.info('VRS', msg))
            .then(r => {
                if (r.success) {
                    VrsDb.reload();
                    syncLog.success('vrs', 'routes updated');
                } else {
                    syncLog.fail('vrs', r.error || 'sync returned success=false');
                }
            })
            .catch(e => {
                logger.error('VRS', `Startup catch-up sync failed: ${e.message}`);
                syncLog.fail('vrs', e.message);
            });
    } catch (e) {
        logger.error('VRS', `Startup check failed: ${e.message}`);
    }
})();

// On startup: run TDX crawl if it has never succeeded or is stale. Unlike
// Mictronics/VRS there was previously no startup check at all for TDX — only
// the 04:00 Asia/Taipei cron — so a process that's down at 4am misses a
// whole day with no catch-up until the next scheduled window.
(function checkTdxOnStartup() {
    const lastEntry = syncLog.get('tdx');
    const ageMs = lastEntry?.lastSuccess ? Date.now() - new Date(lastEntry.lastSuccess).getTime() : Infinity;
    if (ageMs <= DATA_FRESHNESS_THRESHOLDS.tdx) {
        logger.info('TDX', `Startup: ${(ageMs / 3600000).toFixed(1)}h old — within threshold`);
        return;
    }
    logger.info('TDX', `Startup: ${lastEntry?.lastSuccess ? (ageMs / 3600000).toFixed(1) + 'h old' : 'never synced'} — running catch-up crawl...`);
    crawlFlightSchedules();
})();

// ==========================================
// [v11.0] Tactical Background Resolution
// ==========================================
/**
 * Triggers a non-blocking background metadata lookup for new aircraft.
 * Uses the flightController's internal waterfall resolution to populate the Aircraft store.
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

startServer().catch(err => {
    console.error('[FATAL] startServer() threw:', err);
    process.exit(1);
});

// ── Process-level stability handlers ─────────────────────────────────────────

process.on('unhandledRejection', (reason, promise) => {
    logger.error('PROCESS', `Unhandled promise rejection: ${reason}`);
    // Do not exit — log and continue; PM2 will restart if truly unrecoverable
});

process.on('uncaughtException', (err) => {
    logger.error('PROCESS', `Uncaught exception: ${err.message}\n${err.stack}`);
    // Gracefully notify all SSE clients before exiting, so browsers reconnect immediately
    // rather than waiting for TCP timeout (~30s). This reduces LIVE LOST window from
    // "restart duration + TCP timeout" down to just "restart duration".
    try {
        for (const client of sseClients) {
            try { client.end(); } catch (_) {}
        }
    } catch (_) {}
    process.exit(1);
});

process.on('SIGTERM', () => {
    logger.info('PROCESS', 'SIGTERM received — graceful shutdown initiated');
    // Allow in-flight requests to complete; PM2 will wait up to kill_timeout
    process.exit(0);
});
