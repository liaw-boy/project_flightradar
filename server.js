require('dotenv').config({ path: require('path').join(__dirname, '.env') });
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
const { initWebSocketServer, broadcastPlanes, broadcastTelemetry, getActiveViewports } = require('./socketEngine');
const mongoose = require('mongoose'); 
const Route = require('./models/Route'); 
const TrackPoint = require('./models/TrackPoint'); 
const Aircraft = require('./models/Aircraft'); 
const AircraftRegistry = require('./models/AircraftRegistry'); 
const Metar = require('./models/Metar'); 
const Airline = require('./models/Airline'); 
const Airport = require('./models/Airport'); 
const { crawlFlightSchedules } = require('./crawler'); 
const FlightSession = require('./models/FlightSession'); 

// ==========================================
// [Phase 15] MongoDB Connection (Local Only)
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat';

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
}).then(() => console.log(`${getLogTime()} 🍃 [DATABASE] Connected to Local MongoDB`))
  .catch(err => console.error(`${getLogTime()} ❌ [DATABASE] Connection error:`, err));

// ==========================================
// [v4.4.1] Unified Log Timestamp Helper (\x1b[90m is gray)
// ==========================================
function getLogTime() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `\x1b[90m[${h}:${m}:${s}]\x1b[0m`;
}

// ==========================================
// [OPT] Debounce utility
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
app.set('trust proxy', 1); 
const PORT = process.env.PORT || 3000;

// ==========================================
// Middleware
// ==========================================
app.use(cors());
app.use(compression()); 

app.use(express.static(path.join(__dirname, 'public-react'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
        if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript');
        if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css');
    }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please wait a moment.' },
    skip: (req) => req.path === '/api/events', 
});
app.use('/api', apiLimiter);
app.use(express.json());

// ==========================================
// [v2.5.2] 資料缺失日誌系統
// ==========================================
const MISSING_DATA_FILE = path.join(__dirname, 'missing-data.json');
let missingDataLog = {};

function loadMissingDataLog() {
    try {
        if (fs.existsSync(MISSING_DATA_FILE)) {
            missingDataLog = JSON.parse(fs.readFileSync(MISSING_DATA_FILE, 'utf8'));
        }
    } catch (e) { console.error(`${getLogTime()} ❌ [MISSING LOG] Load error:`, e.message); }
}

const _saveMissingDataLogNow = () => {
    fs.writeFile(MISSING_DATA_FILE, JSON.stringify(missingDataLog, null, 2), (e) => {
        if (e) console.error(`${getLogTime()} ❌ [MISSING LOG] Save error:`, e.message);
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
        console.log(`${getLogTime()} 📝 [MISSING LOG] Recorded ${type} for ${icao24}`);
    }
}

function resolveMissingData(icao24, type) {
    const key = icao24.toLowerCase();
    if (missingDataLog[key]) {
        missingDataLog[key].missing = missingDataLog[key].missing.filter(m => m !== type);
        if (missingDataLog[key].missing.length === 0) {
            delete missingDataLog[key];
            console.log(`${getLogTime()} ✅ [MISSING LOG] Resolved all for ${icao24}`);
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
const lastTrackWriteMap = new Map(); 
const activePlanesMap = new Map(); 
const activeSessions = new Map(); // icao24 -> { sessionId, callsign, lastSeen, onGround }
const CACHE_TTL = 30000; 

// ==========================================
// OpenSky API OAuth2 多帳號輪替系統
// ==========================================
const ACCOUNTS = [
    { user: process.env.OPENSKY_USER, pass: process.env.OPENSKY_PASS },
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
    console.log(`${getLogTime()} 🔄 [AUTH] Rotating to account #${currentAccountIndex + 1} (${ACCOUNTS[currentAccountIndex].user})`);
    return true;
}

const SAFE_RESERVE_CAP = 50; 
const QUOTA_CACHE_FILE = path.join(__dirname, 'quota-cache.json');

function saveQuotaCache() {
    try {
        const payload = {
            date: new Date().toISOString().split('T')[0],
            accounts: apiStats.accounts
        };
        fs.writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        console.error(`${getLogTime()} ❌ [QUOTA] Failed to save quota cache:`, e.message);
    }
}

function loadQuotaCache() {
    try {
        if (fs.existsSync(QUOTA_CACHE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(QUOTA_CACHE_FILE, 'utf8'));
            const savedAccounts = Array.isArray(saved) ? saved : (saved.accounts || []);
            const savedDate = Array.isArray(saved) ? null : saved.date;
            const currentDate = new Date().toISOString().split('T')[0];

            if (savedDate === currentDate || !savedDate) {
                apiStats.accounts.forEach(acc => {
                    const found = savedAccounts.find(s => s.user === acc.user);
                    if (found) {
                        acc.remainingCredits = found.remainingCredits;
                        acc.unlockTime = found.unlockTime;
                        acc.rateLimits = found.rateLimits || 0;
                    }
                });
                return true;
            }
        }
    } catch (e) { console.error(`${getLogTime()} ❌ [QUOTA] Failed to load quota cache:`, e.message); }
    return false;
}

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
    if (changed) saveQuotaCache();
}

async function getAuthHeaders(retryCount = 0) {
    if (ACCOUNTS.length === 0) return {};
    if (retryCount >= ACCOUNTS.length) return { 'Authorization': `Bearer ${accountStates[currentAccountIndex].token}` };

    const currentStats = apiStats.accounts[currentAccountIndex];
    if (currentStats.remainingCredits !== null && currentStats.remainingCredits <= SAFE_RESERVE_CAP) {
        const isCurrentlyLimited = currentStats.unlockTime && new Date(currentStats.unlockTime).getTime() > Date.now();
        if (!isCurrentlyLimited) {
            if (rotateAccount()) return await getAuthHeaders(retryCount + 1);
        }
    }

    const account = ACCOUNTS[currentAccountIndex];
    const state = accountStates[currentAccountIndex];

    if (state.token && Date.now() < state.expiresAt) {
        return { 'Authorization': `Bearer ${state.token}` };
    }

    try {
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
            if (rotateAccount()) return await getAuthHeaders(retryCount + 1);
            return {};
        }

        const data = await response.json();
        state.token = data.access_token;
        state.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
        return { 'Authorization': `Bearer ${state.token}` };
    } catch (error) {
        console.error(`${getLogTime()} ❌ [AUTH ERROR] ${error.message}`);
        return {};
    }
}

// ==========================================
// SSE 即時推送系統
// ==========================================
const sseClients = new Set();
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', time: globalPlanesCache.time, count: globalPlanesCache.states.length })}\n\n`);
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), 30000);
    req.on('close', () => {
        sseClients.delete(res);
        clearInterval(heartbeat);
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

app.get('/api/stats', (req, res) => {
    res.json({
        ...apiStats,
        uptimeMinutes: Math.round((Date.now() - apiStats.startTime) / 60000),
        recommendedInterval: calculateRecommendedInterval(),
        activeAccount: ACCOUNTS.length > 0 ? `${currentAccountIndex + 1}/${ACCOUNTS.length} (${ACCOUNTS[currentAccountIndex].user})` : 'none'
    });
});

function calculateRecommendedInterval() {
    if (ACCOUNTS.length === 0) return 30;
    const currentAcc = apiStats.accounts[currentAccountIndex];
    if (currentAcc.unlockTime && new Date(currentAcc.unlockTime).getTime() > Date.now()) return 60;
    if (currentAcc.remainingCredits !== null && currentAcc.remainingCredits <= SAFE_RESERVE_CAP) return 300;
    return 30; 
}

// ==========================================
// [V2.0.0] Global Polling System & BBox API
// ==========================================
let globalPlanesCache = { states: [], time: 0 };
let isFetchingGlobal = false;
let lastGlobalFetchTime = 0;

async function findNearestAirport(lat, lng, maxDistMeters = 10000) {
    try {
        const nearest = await Airport.findOne({
            location: {
                $near: {
                    $geometry: { type: "Point", coordinates: [lng, lat] },
                    $maxDistance: maxDistMeters
                }
            }
        }).lean();
        if (nearest) {
            return {
                icao: nearest.icao, iata: nearest.iata, name: nearest.name, city: nearest.city,
                country: nearest.country, lat: nearest.location.coordinates[1], lng: nearest.location.coordinates[0]
            };
        }
        return null;
    } catch (err) {
        console.error(`${getLogTime()} ❌ [GIS ERROR] findNearestAirport:`, err.message);
        return null;
    }
}

async function learnRouteFromTrajectory(icao24, callsign) {
    if (!callsign || callsign === 'N/A') return;
    try {
        const cleanCS = callsign.toUpperCase().trim();
        const existing = await Route.findOne({ callsign: cleanCS });
        if (existing && existing.source !== 'ai_learned' && existing.departureAirport && existing.arrivalAirport) return;
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const points = await TrackPoint.find({ icao24, timestamp: { $gte: twentyFourHoursAgo } }).sort({ timestamp: 1 }).lean();
        if (points.length < 2) return;
        const depAp = await findNearestAirport(points[0].lat, points[0].lng, 15000);
        const arrAp = await findNearestAirport(points[points.length - 1].lat, points[points.length - 1].lng, 15000);
        if (depAp && arrAp && depAp.icao !== arrAp.icao) {
            await Route.findOneAndUpdate({ callsign: cleanCS }, {
                departureAirport: depAp.icao, arrivalAirport: arrAp.icao, source: 'ai_learned', lastUpdated: new Date()
            }, { upsert: true });
        }
    } catch (e) { console.error(`${getLogTime()} ❌ [AI LEARN ERROR] ${callsign}:`, e.message); }
}

async function fetchOpenSky(params = {}) {
    const headers = await getAuthHeaders();
    let url = 'https://opensky-network.org/api/states/all';
    if (params.lamin !== undefined) url += `?lamin=${params.lamin}&lomin=${params.lomin}&lamax=${params.lamax}&lomax=${params.lomax}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    syncAccountQuota(currentAccountIndex, response);
    apiStats.totalCalls++;
    if (!response.ok) {
        if (response.status === 429) rotateAccount();
        throw new Error(`OpenSky API Error: ${response.status}`);
    }
    const rawJsonText = await response.text();
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'workers', 'parser.js'));
        worker.postMessage(rawJsonText);
        worker.on('message', (msg) => { worker.terminate(); if (msg.success) resolve({ states: msg.planes, time: msg.time }); else reject(new Error(msg.error)); });
        worker.on('error', (err) => { worker.terminate(); reject(err); });
    });
}

async function ingestTrackPoints(states, timeUnix) {
    if (!states || states.length === 0 || mongoose.connection.readyState !== 1) return;
    const timestamp = new Date(timeUnix * 1000);
    const now = Date.now();
    const batchTrackPoints = [];

    for (const p of states) {
        if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
        
        const icao24 = p.icao24.toLowerCase();
        const callsign = (p.callsign || 'N/A').toUpperCase().trim();
        const onGround = !!p.onGround;

        // [SESSION STATE MACHINE]
        let session = activeSessions.get(icao24);
        let needsNewSession = false;

        if (!session) {
            // A. New plane detected
            needsNewSession = true;
        } else if (session.callsign !== callsign && callsign !== 'N/A') {
            // B. Callsign changed (and is not N/A)
            needsNewSession = true;
        } else if (!session.onGround && onGround) {
            // C. Plane just landed - we keep the session until they take off or timeout
            session.onGround = true;
            session.lastSeen = now;
        } else if (session.onGround && !onGround) {
            // D. Plane was on ground and just took off
            needsNewSession = true;
        }

        // Handle session timeout/expiry (e.g. if plane hasn't been seen for 1 hour)
        if (session && (now - session.lastSeen > 3600000)) {
            needsNewSession = true;
        }

        if (needsNewSession) {
            // Mark old session as completed if it exists
            if (session) {
                FlightSession.updateOne({ sessionId: session.sessionId }, { status: 'COMPLETED', endTime: new Date() }).catch(() => {});
            }

            const newSessionId = `${icao24}_${Date.now()}`;
            session = { sessionId: newSessionId, callsign, lastSeen: now, onGround };
            activeSessions.set(icao24, session);

            // Create new session entry in DB
            const newSession = new FlightSession({
                sessionId: newSessionId,
                icao24,
                callsign: callsign !== 'N/A' ? callsign : null,
                startTime: timestamp,
                status: 'ACTIVE'
            });
            newSession.save().catch(e => console.error(`${getLogTime()} ❌ [SESSION DB] Save error:`, e.message));
        } else if (session) {
            session.lastSeen = now;
            session.onGround = onGround;
            if (session.callsign === 'N/A' && callsign !== 'N/A') {
                session.callsign = callsign;
                FlightSession.updateOne({ sessionId: session.sessionId }, { callsign }).catch(() => {});
            }
        }

        // [INGESTION THROTTLE]
        const lastWrite = lastTrackWriteMap.get(icao24) || 0;
        if (now - lastWrite < 20000) continue; 
        lastTrackWriteMap.set(icao24, now);

        batchTrackPoints.push({
            sessionId: session.sessionId,
            icao24,
            timestamp,
            lat: p.lat,
            lng: p.lng,
            altitude: p.altitude || 0,
            geo_altitude: p.geo_altitude || null,
            velocity: p.velocity || 0,
            heading: p.heading || 0,
            vertical_rate: p.vertical_rate || null,
            onGround: p.onGround || false,
            squawk: p.squawk || null
        });
    }

    if (batchTrackPoints.length > 0) {
        try {
            await TrackPoint.insertMany(batchTrackPoints, { ordered: false });
        } catch (e) {
            // ignore duplicate errors or bulk write issues
        }
    }
}

async function fetchGlobalPlanes() {
    if (isFetchingGlobal) return;
    isFetchingGlobal = true;
    const start = performance.now();
    try {
        const data = await fetchOpenSky();
        globalPlanesCache = data;
        broadcastPlanes(data.states, data.time);
        lastGlobalFetchTime = Date.now();
        console.log(`${getLogTime()} \x1b[32m🌏 [GLOBAL] Baseline updated | Latency: ${Math.round(performance.now() - start)}ms | Planes: ${data.states.length}\x1b[0m`);
    } catch (e) { console.warn(`${getLogTime()} ⚠️ [GLOBAL WARN] ${e.message}`); }
    finally { isFetchingGlobal = false; }
    broadcastTelemetry(apiStats, 30);
    ingestTrackPoints(globalPlanesCache.states, globalPlanesCache.time);
}

// ==========================================
// 批次 Metadata 預取
// ==========================================
app.post('/api/metadata/batch', async (req, res) => {
    const { icao24s = [] } = req.body;
    if (mongoose.connection.readyState !== 1 || icao24s.length === 0) return res.json({ fetched: 0 });
    const filteredIcaos = icao24s.filter(id => !aircraftStaticDB[id.toLowerCase()]);
    try {
        const existingInDb = await Aircraft.find({ icao24: { $in: filteredIcaos.map(id => id.toLowerCase()) } }).lean();
        const existingIcaos = new Set(existingInDb.map(a => a.icao24));
        const uncached = filteredIcaos.filter(id => !existingIcaos.has(id.toLowerCase())).slice(0, 10);
        let fetched = 0;
        for (const icao24 of uncached) {
            try {
                const headers = await getAuthHeaders();
                const response = await fetch(`https://opensky-network.org/api/metadata/aircraft/icao/${icao24.toLowerCase()}`, { headers, signal: AbortSignal.timeout(8000) });
                syncAccountQuota(currentAccountIndex, response);
                if (response.ok) {
                    const data = await response.json();
                    await Aircraft.findOneAndUpdate({ icao24: icao24.toLowerCase() }, { ...data, icao24: icao24.toLowerCase(), lastUpdated: new Date() }, { upsert: true });
                    fetched++;
                }
            } catch (e) {}
        }
        res.json({ fetched });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// [v4.6.0] 航班路由與數據模型
// ==========================================
const LOCAL_ROUTES_FILE = path.join(__dirname, 'data', 'local_routes.json');
const SCHEDULES_STATIC_FILE = path.join(__dirname, 'data', 'schedules_static.json');
const AIRCRAFT_STATIC_FILE = path.join(__dirname, 'data', 'aircraft_static.json');

let localRoutesDB = {}, schedulesStaticDB = {}, aircraftStaticDB = {}, globalAirlinesDB = {};

function loadGlobalData() {
    globalAirlinesDB = {
        "SJX": { iata: "JX", name: "Starlux" },
        "CAL": { iata: "CI", name: "China Airlines" },
        "EVA": { iata: "BR", name: "EVA Air" },
        "APJ": { iata: "MM", name: "Peach" },
        "TTW": { iata: "IT", name: "Tigerair Taiwan" },
        "TGW": { iata: "TR", name: "Scoot" },
        "VJC": { iata: "VJ", name: "VietJet" },
        "JJP": { iata: "GK", name: "Jetstar Japan" },
        "CQH": { iata: "9C", name: "Spring Airlines" },
        "CSX": { iata: "ZH", name: "Shenzhen Airlines" }
    };
    try {
        if (fs.existsSync(LOCAL_ROUTES_FILE)) localRoutesDB = JSON.parse(fs.readFileSync(LOCAL_ROUTES_FILE, 'utf8'));
        if (fs.existsSync(SCHEDULES_STATIC_FILE)) schedulesStaticDB = JSON.parse(fs.readFileSync(SCHEDULES_STATIC_FILE, 'utf8'));
        if (fs.existsSync(AIRCRAFT_STATIC_FILE)) aircraftStaticDB = JSON.parse(fs.readFileSync(AIRCRAFT_STATIC_FILE, 'utf8'));
    } catch (e) { console.error("Error loading static data:", e.message); }
}
loadGlobalData();

function resolveAirlineAlias(callsign) {
    if (!callsign) return null;
    const match = callsign.match(/^([A-Z]{2,3})(\d+)$/);
    if (!match) return callsign;
    const code = match[1], num = match[2];
    const alias = globalAirlinesDB[code];
    if (alias) return { original: callsign, alias: (alias.iata || alias.icao) + num };
    return callsign;
}

const routeCache = new Map();
const ROUTE_CACHE_TTL = 1800000;

app.get('/api/airports/list', async (req, res) => {
    try {
        const airports = await Airport.find({}, { icao: 1, iata: 1, name: 1, city: 1, country: 1, location: 1 }).limit(5000).lean();
        res.json(airports.map(a => ({ ...a, lat: a.location.coordinates[1], lng: a.location.coordinates[0] })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/airport/:code', async (req, res) => {
    const code = req.params.code.toUpperCase().trim();
    try {
        const dbAp = await Airport.findOne({ $or: [{ icao: code }, { iata: code }] }).lean();
        if (dbAp) return res.json({ ...dbAp, lat: dbAp.location.coordinates[1], lng: dbAp.location.coordinates[0], source: 'mongodb' });
        const metar = await Metar.findOne({ icaoId: code }).lean();
        if (metar) return res.json({ ...metar, source: 'metar_db' });
        res.status(404).json({ error: 'Not found' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/route/:icao24', async (req, res) => {
    const icao24 = req.params.icao24.toLowerCase();
    const callsign = (req.query.callsign || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let search = [callsign];
    const resolved = resolveAirlineAlias(callsign);
    if (resolved && resolved.alias) search.push(resolved.alias);

    let route = null, source = '';
    for (const cs of search) {
        if (!cs) continue;
        if (schedulesStaticDB[cs]) { route = schedulesStaticDB[cs]; source = 'static_db'; break; }
        if (localRoutesDB[cs]) { route = { dep: localRoutesDB[cs][0], arr: localRoutesDB[cs][1] }; source = 'local_dict'; break; }
        const dbRoute = await Route.findOne({ callsign: new RegExp(`^${cs}$`, 'i') }).lean();
        if (dbRoute) { route = { dep: dbRoute.departureAirport, arr: dbRoute.arrivalAirport }; source = dbRoute.source || 'mongodb'; break; }
    }

    if (route) {
        let depLoc = null, arrLoc = null;
        try {
            const d = await Airport.findOne({ icao: route.dep || route.departureAirport }).lean();
            const a = await Airport.findOne({ icao: route.arr || route.arrivalAirport }).lean();
            if (d) depLoc = { lat: d.location.coordinates[1], lng: d.location.coordinates[0] };
            if (a) arrLoc = { lat: a.location.coordinates[1], lng: a.location.coordinates[0] };
        } catch (e) {}
        return res.json({ icao24, callsign, departureAirport: route.dep || route.departureAirport, arrivalAirport: route.arr || route.arrivalAirport, departureLocation: depLoc, arrivalLocation: arrLoc, source });
    }

    const cached = routeCache.get(icao24);
    if (cached && (Date.now() - cached.timestamp < ROUTE_CACHE_TTL)) return res.json(cached.data);

    try {
        const track = await fetchTracksInternal(icao24);
        if (track && track.path && track.path.length > 0) {
            const nearest = await findNearestAirport(track.path[0][1], track.path[0][2], 15000);
            if (nearest) {
                const result = { icao24, callsign, departureAirport: nearest.icao, source: 'spatial' };
                routeCache.set(icao24, { data: result, timestamp: Date.now() });
                return res.json(result);
            }
        }
    } catch (e) {}
    res.json({ icao24, callsign, noData: true });
});

// ==========================================
// 飛機軌跡 Tracks API
// ==========================================
async function fetchTracksInternal(icao24) {
    try {
        const icao = icao24.toLowerCase();
        // 1. Find the most recent or active session
        const session = await FlightSession.findOne({ icao24: icao }).sort({ startTime: -1 }).lean();
        if (!session) return { icao24, path: [] };

        // 2. Fetch all points for this specific session
        const points = await TrackPoint.find({ sessionId: session.sessionId }).sort({ timestamp: 1 }).lean();
        
        // 3. Map to path format: [timestamp, lat, lng, altitude, heading, velocity, onGround]
        const path = points.map(pt => [
            Math.floor(pt.timestamp.getTime() / 1000),
            pt.lat,
            pt.lng,
            pt.altitude || 0,
            pt.heading || 0,
            pt.velocity || 0,
            pt.onGround ? 1 : 0
        ]);
        
        return { 
            icao24, 
            sessionId: session.sessionId,
            callsign: session.callsign,
            status: session.status,
            path 
        };
    } catch (e) { 
        console.error(`${getLogTime()} ❌ [TRACKS ERROR] ${icao24}:`, e.message);
        return { icao24, path: [] }; 
    }
}

app.get('/api/tracks', async (req, res) => {
    const icao24 = req.query.icao24;
    if (!icao24) return res.status(400).json({ error: 'Missing icao24' });
    res.json(await fetchTracksInternal(icao24.toLowerCase()));
});

// ==========================================
// METAR 機場天氣 API
// ==========================================
async function fetchMetarData() {
    if (mongoose.connection.readyState !== 1) return;
    try {
        const url = `https://aviationweather.gov/api/data/metar?ids=RCTP,RCSS,RCKH,RCKH,RJTT,RJAA,RKSI,VHHH,WSSS,VTBS&format=json`;
        const res = await fetch(url);
        const data = await res.json();
        const ops = data.map(info => ({
            updateOne: { filter: { icaoId: info.icaoId.toUpperCase() }, update: { $set: { ...info, lastUpdated: new Date() } }, upsert: true }
        }));
        if (ops.length > 0) await Metar.bulkWrite(ops);
    } catch (e) {}
}
setInterval(fetchMetarData, 3600000);
fetchMetarData();

app.get('/api/metar', async (req, res) => {
    const { icao } = req.query;
    try {
        if (icao) return res.json(await Metar.findOne({ icaoId: icao.toUpperCase() }).lean() || { error: 'Not found' });
        res.json(await Metar.find({}).lean());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public-react', 'index.html')));

async function syncSchedulesDatabase() {
    try {
        const res = await fetch('https://raw.githubusercontent.com/LiaoCho/flight-data-source/main/schedules_latest.json');
        if (res.ok) {
            const data = await res.json();
            fs.writeFileSync(SCHEDULES_STATIC_FILE, JSON.stringify(data, null, 2));
            schedulesStaticDB = data;
        }
    } catch (e) {}
}
cron.schedule('0 3 * * *', syncSchedulesDatabase);

const server = http.createServer(app);
initWebSocketServer(server);
server.listen(PORT, () => {
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   ✈️  AEROSTRAT Surveillance Server      ║');
    console.log(`║   🌐 http://localhost:${PORT}               ║`);
    console.log(`║   🔐 Version: v4.6.0                     ║`);
    console.log('╚══════════════════════════════════════════╝');
    crawlFlightSchedules();
    fetchGlobalPlanes();
    setInterval(fetchGlobalPlanes, 30000);
});
