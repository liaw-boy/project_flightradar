require('dotenv').config({ path: require('path').join(__dirname, '.env') });
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
const { initWebSocketServer, broadcastPlanes, broadcastTelemetry, getActiveViewports } = require('./socketEngine');
const mongoose = require('mongoose'); // [Phase 15] Database Persistence
const Route = require('./models/Route'); // [Phase 15] Route Schema
const TrackPoint = require('./models/TrackPoint'); // [Time Series] Historical Tracks
const Aircraft = require('./models/Aircraft'); // [Cache Migration]
const Metar = require('./models/Metar'); // [Cache Migration]
const FlightSession = require('./models/FlightSession'); // [Flight Sessions]
const Airport = require('./models/Airport'); // [GIS Modernization]
const AircraftShape = require('./models/AircraftShape'); // [SVG Shapes]
const { crawlFlightSchedules } = require('./crawler'); // [CRAWLER] Real-time schedules

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
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat';

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
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

// ==========================================
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
const PORT = process.env.PORT || 3000;

// ==========================================
// Middleware
// ==========================================
app.use(cors());
app.use(compression()); // [v2.9.0] Gzip

// [v5.0.0] Static file serving REMOVED — Frontend runs independently via Vite Dev Server
// Backend is now a pure API + WebSocket data engine


// [v3.0] Security Headers
app.use(helmet({
    contentSecurityPolicy: false, // Prevents blocking of inline scripts and external map tiles
    crossOriginEmbedderPolicy: false, // Prevents blocking of external assets
}));
// Rate limiter: 200 req/min per IP（選飛機會同時觸發 metadata+route+track 3 個請求）
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please wait a moment.' },
    skip: (req) => req.path === '/api/events', // SSE exempt
});
app.use('/api', apiLimiter);
app.use(express.json());

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
            console.log(`🛡️ [RESERVE] Account ${ACCOUNTS[currentAccountIndex].user} hit safe floor (${currentStats.remainingCredits}). Rotating preemptively...`);
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
// 動作紀錄 API (讓前端的操作顯示在後台中端)
app.post('/api/log', (req, res) => {
    const { message, type = 'info', data = {} } = req.body;
    const timestamp = new Date().toLocaleTimeString();
    const prefix = type === 'error' ? '❌ [CLIENT ERROR]' : type === 'warn' ? '⚠️ [CLIENT WARN]' : '📱 [USER ACTION]';

    console.log(`${prefix} [${timestamp}] ${message}`, Object.keys(data).length > 0 ? data : '');
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
        timestamp: new Date().toISOString()
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
 * [Time Series] Helper to ingest raw plane data into MongoDB
 * Standardizes format, lowercases ICAO24, and filters out corrupted coordinates.
 */
async function ingestTrackPoints(states, timeUnix) {
    if (!states || states.length === 0) return;

    // [HOTFIX] 連線狀態守衛：確保 MongoDB 已連線 (readyState === 1) 才允許寫入
    if (mongoose.connection.readyState !== 1) {
        console.warn('⚠️ [DATABASE] Skip ingestion: MongoDB is not connected yet.');
        return;
    }

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
            needsNewSession = true;
        } else if (session.callsign !== callsign && callsign !== 'N/A') {
            needsNewSession = true;
        } else if (!session.onGround && onGround) {
            session.onGround = true;
            session.lastSeen = now;
        } else if (session.onGround && !onGround) {
            needsNewSession = true;
        }

        if (session && (now - session.lastSeen > 3600000)) {
            needsNewSession = true;
        }

        if (needsNewSession) {
            if (session) {
                FlightSession.updateOne({ sessionId: session.sessionId }, { status: 'COMPLETED', endTime: new Date() }).catch(() => {});
            }

            const newSessionId = `${icao24}_${Date.now()}`;
            session = { sessionId: newSessionId, callsign, lastSeen: now, onGround };
            activeSessions.set(icao24, session);

            const newSession = new FlightSession({
                sessionId: newSessionId,
                icao24,
                callsign: callsign !== 'N/A' ? callsign : null,
                startTime: timestamp,
                status: 'ACTIVE'
            });
            newSession.save().catch(e => console.error(`❌ [SESSION DB] Save error:`, e.message));
        } else if (session) {
            session.lastSeen = now;
            session.onGround = onGround;
            if (session.callsign === 'N/A' && callsign !== 'N/A') {
                session.callsign = callsign;
                FlightSession.updateOne({ sessionId: session.sessionId }, { callsign }).catch(() => {});
            }
        }

        batchTrackPoints.push({
            sessionId: session.sessionId,
            icao24,
            timestamp,
            lat: p.lat,
            lng: p.lng,
            altitude: (typeof p.altitude === 'number') ? p.altitude : 0,
            velocity: p.velocity || 0,
            heading: p.heading || 0,
            onGround: onGround
        });
    }

    if (batchTrackPoints.length === 0) return;

    try {
        await TrackPoint.insertMany(batchTrackPoints, { ordered: false });
    } catch (err) {
        if (err.name !== 'MongoBulkWriteError' && err.name !== 'MongoServerError') {
            console.error('❌ [DATABASE] Ingestion error:', err.message);
        }
    }
}

// 改寫原本的 fetchGlobalPlanes 為 fetchOpenSky 的封裝
async function fetchGlobalPlanes() {
    if (isFetchingGlobal) return;
    isFetchingGlobal = true;
    const start = performance.now();
    const acc = ACCOUNTS[currentAccountIndex];
    
    try {
        const data = await fetchOpenSky();
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
    broadcastTelemetry(apiStats, 30);

    // [Audit Fix] Use centralized ingestion helper
    ingestTrackPoints(globalPlanesCache.states, globalPlanesCache.time);
}

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

    // Check Global Database first
    if (globalAirportsDB[code]) {
        return res.json(globalAirportsDB[code]);
    }

    // Check METAR collection (Fallback) [Phase 15 Migration]
    try {
        const metarAirport = await Metar.findOne({ $or: [{ icaoId: code }, { iataId: code }] }).lean();
        if (metarAirport) {
            return res.json({
                icao: metarAirport.icaoId,
                iata: metarAirport.iataId,
                name: metarAirport.name,
                city: metarAirport.city,
                country: metarAirport.country,
                lat: metarAirport.lat,
                lon: metarAirport.lon,
                source: 'metar_db'
            });
        }
    } catch (e) { /* ignore fallback errors */ }

    return res.status(404).json({ error: 'Airport not found' });
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
        // [DB CACHE] 1. 優先從 MongoDB 讀取
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

        // 2. 緩存失效，抓取外部 API
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

        // [DB CACHE] 3. 若抓到圖片，非同步存入資料庫
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
        if (dbRoute) {
            console.log(`🎯 [DB HIT] Found persistent route for ${callsign}: ${dbRoute.departureAirport} -> ${dbRoute.arrivalAirport}`);
            return res.json({
                callsign,
                departureAirport: dbRoute.departureAirport,
                arrivalAirport: dbRoute.arrivalAirport,
                source: 'mongodb_cache',
                lastUpdated: dbRoute.lastUpdated
            });
        }

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
                { upsert: true, new: true }
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
 * [OPT 1.3] 內部 track 取得函式，不透過 HTTP 迴環
 * 供 /api/route 的空間推測直接呼叫
 */
async function fetchTracksInternal(icao24) {
    if (mongoose.connection.readyState !== 1) {
        return { icao24, path: [], error: 'Database not connected' };
    }
    const cached = trackCache.get(icao24);
    if (cached && (Date.now() - cached.timestamp < TRACK_CACHE_TTL)) {
        return cached.data;
    }
    try {
        const icao = icao24.toLowerCase();
        // 尋找當前航班的 Session
        const session = await FlightSession.findOne({ icao24: icao }).sort({ startTime: -1 }).lean();
        if (!session) return { icao24, path: [] };

        // 使用 sessionId 來撈取專屬軌跡
        const points = await TrackPoint.find({ sessionId: session.sessionId }).sort({ timestamp: 1 }).lean();

        const path = points.map(pt => [
            Math.floor(pt.timestamp.getTime() / 1000),
            pt.lat,
            pt.lng,
            pt.altitude || 0,
            pt.heading || 0,
            pt.velocity || 0,
            pt.onGround ? 1 : 0
        ]);

        const result = { icao24, path };
        trackCache.set(icao24, { data: result, timestamp: Date.now() });
        return result;
    } catch (e) {
        return { icao24, path: [], noData: true, error: e.message };
    }
}

app.get('/api/tracks', async (req, res) => {
    const icao24 = req.query.icao24;
    if (!icao24) return res.status(400).json({ error: 'Missing icao24' });
    const result = await fetchTracksInternal(icao24);
    res.json(result);
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

// 啟動伺服器
const server = http.createServer(app);
initWebSocketServer(server);

server.listen(PORT, () => {
    const readyTime = new Date().toLocaleTimeString();
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   ✈️  AEROSTRAT API Engine (Decoupled)    ║');
    console.log(`║   🌐 API: http://localhost:${PORT}            ║`);
    console.log(`║   🔌 WS:  ws://localhost:${PORT}/ws           ║`);
    console.log(`║   🔐 Version: v5.0.0 (Zero Downtime)     ║`);
    console.log(`║   ⏱️  Ready: ${readyTime}                 ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
});
