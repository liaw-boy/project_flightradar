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
<<<<<<< HEAD:backend/server.js
const mongoose = require('mongoose'); // [Phase 15] Database Persistence
const Route = require('./models/Route'); // [Phase 15] Route Schema
const TrackPoint = require('./models/TrackPoint'); // [Time Series] Historical Tracks
const Aircraft = require('./models/Aircraft'); // [Cache Migration]
const Metar = require('./models/Metar'); // [Cache Migration]
const FlightSession = require('./models/FlightSession'); // [Flight Sessions]
const Airport = require('./models/Airport'); // [GIS Modernization]
const AircraftShape = require('./models/AircraftShape'); // [SVG Shapes]

// ==========================================
// [v4.4.0] Logging Helper with Tactical Timestamps
// ==========================================
function getTime() {
    return `[${new Date().toLocaleTimeString('en-US', { hour12: false })}]`;
}

=======
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
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js

// ==========================================
// [Phase 15] MongoDB Connection (Local Only)
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat';

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
<<<<<<< HEAD:backend/server.js
}).then(() => {
    console.log(`${getTime()} 🍃 [DATABASE] Connected to Local MongoDB`);
    restoreActiveSessions();
})
  .catch(err => console.error('❌ [DATABASE] Connection error:', err));

mongoose.connection.on('error', err => {
    console.error('❌ [DATABASE] Runtime connection error:', err);
});

mongoose.connection.on('disconnected', () => {
    console.warn('⚠️ [DATABASE] MongoDB disconnected.');
});

mongoose.connection.on('reconnected', () => {
    console.log('✅ [DATABASE] MongoDB reconnected.');
});
=======
}).then(() => console.log(`${getLogTime()} 🍃 [DATABASE] Connected to Local MongoDB`))
  .catch(err => console.error(`${getLogTime()} ❌ [DATABASE] Connection error:`, err));
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js

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

<<<<<<< HEAD:backend/server.js
// [v5.0.0] Static file serving REMOVED — Frontend runs independently via Vite Dev Server
// Backend is now a pure API + WebSocket data engine

=======
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
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));
<<<<<<< HEAD:backend/server.js
// Rate limiter: 200 req/min per IP（選飛機會同時觸發 metadata+route+track 3 個請求）
=======
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
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
<<<<<<< HEAD:backend/server.js
        console.log(`${getTime()} 📝 [MISSING LOG] Recorded ${type} for ${icao24}`);
=======
        console.log(`${getLogTime()} 📝 [MISSING LOG] Recorded ${type} for ${icao24}`);
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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
<<<<<<< HEAD:backend/server.js
const activeSessions = new Map(); // [Flight Sessions] icao24 -> { sessionId, callsign, lastSeen, onGround }

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
=======
const lastTrackWriteMap = new Map(); 
const activePlanesMap = new Map(); 
const activeSessions = new Map(); // icao24 -> { sessionId, callsign, lastSeen, onGround }
const CACHE_TTL = 30000; 
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js

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
<<<<<<< HEAD:backend/server.js
    console.log(`${getTime()} 📡 [SSE] Client connected. Total: ${sseClients.size}`);

    // 立即發送当前資料快照
=======
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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
<<<<<<< HEAD:backend/server.js
// [v3.0] 飛行異常偵測引擎
// 每次 globalPlanesCache 更新後這行，偵測危險狀態後用 SSE 廣播
// ==========================================
const _prevStates = new Map(); // icao24 -> prev state for diff

// 機場快取
const airportListCache = [];
function detectAnomalies(states) {
    const alerts = [];
    for (const s of states) {
        const icao24 = s[0];
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
        timestamp: new Date().toISOString()
    });
});

// ==========================================
=======
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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

<<<<<<< HEAD:backend/server.js
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
=======
async function findNearestAirport(lat, lng, maxDistMeters = 10000) {
    try {
        const nearest = await Airport.findOne({
            location: {
                $near: {
                    $geometry: { type: "Point", coordinates: [lng, lat] },
                    $maxDistance: maxDistMeters
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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

<<<<<<< HEAD:backend/server.js
/**
 * 核心：向 OpenSky 發起請求的新型通用函數
 */
=======
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

>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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
<<<<<<< HEAD:backend/server.js
            needsNewSession = true;
        } else if (session.callsign !== callsign && callsign !== 'N/A') {
            needsNewSession = true;
        } else if (!session.onGround && onGround) {
            session.onGround = true;
            session.lastSeen = now;
        } else if (session.onGround && !onGround) {
            needsNewSession = true;
        }

=======
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
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
        if (session && (now - session.lastSeen > 3600000)) {
            needsNewSession = true;
        }

        if (needsNewSession) {
<<<<<<< HEAD:backend/server.js
=======
            // Mark old session as completed if it exists
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
            if (session) {
                FlightSession.updateOne({ sessionId: session.sessionId }, { status: 'COMPLETED', endTime: new Date() }).catch(() => {});
            }

            const newSessionId = `${icao24}_${Date.now()}`;
            session = { sessionId: newSessionId, callsign, lastSeen: now, onGround };
            activeSessions.set(icao24, session);

<<<<<<< HEAD:backend/server.js
=======
            // Create new session entry in DB
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
            const newSession = new FlightSession({
                sessionId: newSessionId,
                icao24,
                callsign: callsign !== 'N/A' ? callsign : null,
                startTime: timestamp,
                status: 'ACTIVE'
            });
<<<<<<< HEAD:backend/server.js
            newSession.save().catch(e => console.error(`❌ [SESSION DB] Save error:`, e.message));
=======
            newSession.save().catch(e => console.error(`${getLogTime()} ❌ [SESSION DB] Save error:`, e.message));
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
        } else if (session) {
            session.lastSeen = now;
            session.onGround = onGround;
            if (session.callsign === 'N/A' && callsign !== 'N/A') {
                session.callsign = callsign;
                FlightSession.updateOne({ sessionId: session.sessionId }, { callsign }).catch(() => {});
            }
        }

<<<<<<< HEAD:backend/server.js
=======
        // [INGESTION THROTTLE]
        const lastWrite = lastTrackWriteMap.get(icao24) || 0;
        if (now - lastWrite < 20000) continue; 
        lastTrackWriteMap.set(icao24, now);

>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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
<<<<<<< HEAD:backend/server.js
            onGround: onGround
        });
    }

    if (batchTrackPoints.length === 0) return;

    try {
        await TrackPoint.insertMany(batchTrackPoints, { ordered: false });
    } catch (err) {
        if (err.name !== 'MongoBulkWriteError' && err.name !== 'MongoServerError') {
            console.error('❌ [DATABASE] Ingestion error:', err.message);
=======
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
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
        }
    }
}

<<<<<<< HEAD:backend/server.js
// 改寫原本的 fetchGlobalPlanes 為 fetchOpenSky 的封裝
=======
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
async function fetchGlobalPlanes() {
    if (isFetchingGlobal) return;
    isFetchingGlobal = true;
    const start = performance.now();
    try {
        const data = await fetchOpenSky();
<<<<<<< HEAD:backend/server.js
        const fetchLatency = Math.round(performance.now() - start);
        
        let enrichedStates = data.states;
        let enrichedCount = 0;

        // [Architecture Upgrade] Background Pre-Stitching Metadata
        try {
            const icaoList = data.states.map(p => p.icao24.toLowerCase());
            // Use .lean() for maximum performance and minimum memory footprint
            const metadata = await Aircraft.find({ icao24: { $in: icaoList } }, { icao24: 1, typecode: 1, model: 1 }).lean();
            
            const metaMap = new Map(metadata.map(m => [m.icao24, m.typecode || m.model || '']));
            
            enrichedStates = data.states.map(p => {
                const typecode = metaMap.get(p.icao24.toLowerCase());
                if (typecode) enrichedCount++;
                return { ...p, typecode: typecode || null };
            });
        } catch (dbErr) {
            console.warn(`${getTime()} ⚠️ [METADATA PRE-STITCH] DB Lookup failed: ${dbErr.message}. Proceding with basic data.`);
        }

        const totalLatency = Math.round(performance.now() - start);
        
        globalPlanesCache = { states: enrichedStates, time: data.time, stale: false };
        broadcastPlanes(enrichedStates, data.time);
        lastGlobalFetchTime = Date.now();
        
        console.log(`${getTime()} \x1b[32m🌏 [GLOBAL] Baseline updated | Latency: ${totalLatency}ms (Fetch: ${fetchLatency}ms) | Planes: ${data.states.length} (Enriched: ${enrichedCount}) | Acc: #${currentAccountIndex + 1} (${acc.user})\x1b[0m`);
    } catch (e) {
        if (e.message.includes('429') || e.message.includes('timeout')) {
            console.warn(`${getTime()} \x1b[33m⚠️ [GLOBAL WARN] ${e.message}. Freezing cache until next window.\x1b[0m`);
            globalPlanesCache.stale = true;
        } else {
            console.error(`${getTime()} \x1b[31m❌ [GLOBAL ERROR] ${e.message}\x1b[0m`);
            globalPlanesCache.stale = true;
        }
    } finally {
        isFetchingGlobal = false;
    }

    // [v4.3.5] Broadcast precise global telemetry
=======
        globalPlanesCache = data;
        broadcastPlanes(data.states, data.time);
        lastGlobalFetchTime = Date.now();
        console.log(`${getLogTime()} \x1b[32m🌏 [GLOBAL] Baseline updated | Latency: ${Math.round(performance.now() - start)}ms | Planes: ${data.states.length}\x1b[0m`);
    } catch (e) { console.warn(`${getLogTime()} ⚠️ [GLOBAL WARN] ${e.message}`); }
    finally { isFetchingGlobal = false; }
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
    broadcastTelemetry(apiStats, 30);
    ingestTrackPoints(globalPlanesCache.states, globalPlanesCache.time);
}

<<<<<<< HEAD:backend/server.js
// 啟動 30 秒全球資料輪詢機制 (配合 CACHE_TTL=30s)
setInterval(fetchGlobalPlanes, 30000);
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
=======
// ==========================================
// 批次 Metadata 預取
// ==========================================
app.post('/api/metadata/batch', async (req, res) => {
    const { icao24s = [] } = req.body;
    if (mongoose.connection.readyState !== 1 || icao24s.length === 0) return res.json({ fetched: 0 });
    const filteredIcaos = icao24s.filter(id => !aircraftStaticDB[id.toLowerCase()]);
    try {
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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
<<<<<<< HEAD:backend/server.js

        console.log(`${getTime()} 📦 [BATCH] Fetched ${fetched}/${toFetch.length} metadata to MongoDB`);
        res.json({ fetched: fetched, requested: toFetch.length });
    } catch (err) {
        console.error('❌ [BATCH ERROR]', err.message);
        res.status(500).json({ fetched: 0, error: err.message });
    }
=======
        res.json({ fetched });
    } catch (err) { res.status(500).json({ error: err.message }); }
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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
<<<<<<< HEAD:backend/server.js

// [OPT 1.1] 機場清單快取變數與函式——必須在 loadGlobalData()/buildAirportGrid() 之前宣告
let _cachedAirportList = null;
let _cachedAirportListETag = '';

async function buildAirportListCache() {
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

=======
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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

<<<<<<< HEAD:backend/server.js
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
=======
app.get('/api/airports/list', async (req, res) => {
    try {
        const airports = await Airport.find({}, { icao: 1, iata: 1, name: 1, city: 1, country: 1, location: 1 }).limit(5000).lean();
        res.json(airports.map(a => ({ ...a, lat: a.location.coordinates[1], lng: a.location.coordinates[0] })));
    } catch (e) { res.status(500).json({ error: e.message }); }
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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

<<<<<<< HEAD:backend/server.js
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
        let photos = [];

        const hexRes = await fetch(`https://api.planespotters.net/pub/photos/hex/${icao24}`, {
            headers: { 'User-Agent': 'AEROSTRAT/4.4 (flight-tracking)' }
        });
        if (hexRes.ok) {
            const data = await hexRes.json();
            if (data.photos?.length) photos = data.photos;
        }

        if (photos.length === 0 && reg && reg !== 'N/A') {
            const regRes = await fetch(`https://api.planespotters.net/pub/photos/reg/${reg}`, {
                headers: { 'User-Agent': 'AEROSTRAT/4.4 (flight-tracking)' }
            });
            if (regRes.ok) {
                const data = await regRes.json();
                if (data.photos?.length) photos = data.photos;
            }
        }

        res.setHeader('Cache-Control', 'public, max-age=3600'); // 1h 快取
        res.json(photos);
    } catch (err) {
        console.error('[PHOTOS] Proxy error:', err.message);
        res.status(500).json({ error: 'Photo fetch failed' });
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

=======
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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
<<<<<<< HEAD:backend/server.js
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
                return res.json(inferredResult);
=======
        const track = await fetchTracksInternal(icao24);
        if (track && track.path && track.path.length > 0) {
            const nearest = await findNearestAirport(track.path[0][1], track.path[0][2], 15000);
            if (nearest) {
                const result = { icao24, callsign, departureAirport: nearest.icao, source: 'spatial' };
                routeCache.set(icao24, { data: result, timestamp: Date.now() });
                return res.json(result);
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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
<<<<<<< HEAD:backend/server.js
        // 尋找當前航班的 Session
        const session = await FlightSession.findOne({ icao24: icao }).sort({ startTime: -1 }).lean();
        if (!session) return { icao24, path: [] };

        // 使用 sessionId 來撈取專屬軌跡
        const points = await TrackPoint.find({ sessionId: session.sessionId }).sort({ timestamp: 1 }).lean();
=======
        // 1. Find the most recent or active session
        const session = await FlightSession.findOne({ icao24: icao }).sort({ startTime: -1 }).lean();
        if (!session) return { icao24, path: [] };
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js

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
<<<<<<< HEAD:backend/server.js
    const result = await fetchTracksInternal(icao24);
    res.json(result);
});

=======
    res.json(await fetchTracksInternal(icao24.toLowerCase()));
});
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js

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
<<<<<<< HEAD:backend/server.js
// [API 404 防火牆]
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});


// ==========================================
// 自動化資料庫引擎 (Background Auto-Sync)
// ==========================================
=======

app.use((req, res) => res.sendFile(path.join(__dirname, 'public-react', 'index.html')));

>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
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
<<<<<<< HEAD:backend/server.js
    console.log('║   ✈️  AEROSTRAT API Engine (Decoupled)    ║');
    console.log(`║   🌐 API: http://localhost:${PORT}            ║`);
    console.log(`║   🔌 WS:  ws://localhost:${PORT}/ws           ║`);
    console.log(`║   🔐 Version: v5.0.0 (Zero Downtime)     ║`);
    console.log(`║   ⏱️  Ready: ${readyTime}                 ║`);
=======
    console.log('║   ✈️  AEROSTRAT Surveillance Server      ║');
    console.log(`║   🌐 http://localhost:${PORT}               ║`);
    console.log(`║   🔐 Version: v4.6.0                     ║`);
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:server.js
    console.log('╚══════════════════════════════════════════╝');
    crawlFlightSchedules();
    fetchGlobalPlanes();
    setInterval(fetchGlobalPlanes, 30000);
});
