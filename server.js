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

// ==========================================
// [Phase 15] MongoDB Connection (Local Only)
// ==========================================
// We default to local MongoDB to ensure privacy and speed.
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat';

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
}).then(() => console.log('🍃 [DATABASE] Connected to Local MongoDB'))
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

// [v2.9.0] Serve static files BEFORE security middleware
// This prevents helmet's nosniff from blocking JS/CSS MIME types
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

// [v3.0] Security Headers
app.use(helmet({
    contentSecurityPolicy: false, // Prevents blocking of inline scripts and external map tiles
    crossOriginEmbedderPolicy: false, // Prevents blocking of external assets
}));
// [v3.0] Rate limiter: 120 req/min per IP on all API endpoints
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
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
        console.log(`📝 [MISSING LOG] Recorded ${type} for ${icao24}`);
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
const CACHE_TTL = 60000; // 60 秒快取 (配合前端 60s 輪詢)

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
    console.log(`🔄 [AUTH] Rotating to account #${currentAccountIndex + 1} (${ACCOUNTS[currentAccountIndex].user})`);
    return true;
}

const SAFE_RESERVE_CAP = 50; // 每個帳號保留至少 50 次額度 (User Specified)
const QUOTA_CACHE_FILE = path.join(__dirname, 'quota-cache.json');

function saveQuotaCache() {
    try {
        const payload = {
            date: new Date().toISOString().split('T')[0], // YYYY-MM-DD (UTC)
            accounts: apiStats.accounts
        };
        fs.writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        console.error('❌ [QUOTA] Failed to save quota cache:', e.message);
    }
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
    console.log(`📡 [SSE] Client connected. Total: ${sseClients.size}`);

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
function findNearestAirport(lat, lng, maxDist = 8) {
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

// [Project AERO-SYNC] Viewport-Driven Adaptive Fetcher
const bboxActiveRequests = new Map();
const bboxFetchHistory = new Map();

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
    const trackPoints = states
        .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number') // Second-layer safety
        .map(p => ({
            icao24: p.icao24.toLowerCase(), // Force casing consistency
            timestamp,
            lat: p.lat,
            lng: p.lng,
            altitude: (typeof p.altitude === 'number') ? p.altitude : 0,
            velocity: p.velocity || 0,
            heading: p.heading || 0
        }));

    if (trackPoints.length === 0) return;

    try {
        await TrackPoint.insertMany(trackPoints, { ordered: false });
    } catch (err) {
        // Bulk write errors are expected (e.g. duplicate keys in same snapshot time)
        if (err.name !== 'MongoBulkWriteError' && err.name !== 'MongoServerError') {
            console.error('❌ [DATABASE] Ingestion error:', err.message);
        }
    }
}

/**
 * [V3.0] 視角驅動自適應抓取迴圈
 */
async function runAdaptiveViewportPolling() {
    const viewports = getActiveViewports();
    if (viewports.length === 0) return;

    for (const v of viewports) {
        // 1. 生成聚合 Key (四捨五入至小數點後 1 位，增加命中率)
        const key = `${v.lamin.toFixed(1)}_${v.lomin.toFixed(1)}_${v.lamax.toFixed(1)}_${v.lomax.toFixed(1)}`;

        // 2. 決定採樣頻率 (面積小於 10 單位視為「區域」，給予 10s 更新)
        const area = Math.abs(v.lamax - v.lamin) * Math.abs(v.lomax - v.lomin);
        const interval = area < 20 ? 10000 : 60000;

        const lastFetch = bboxFetchHistory.get(key) || 0;
        if (Date.now() - lastFetch < interval) continue;
        if (bboxActiveRequests.has(key)) continue;

        // 3. 請求聚合
        const p = (async () => {
            try {
                const data = await fetchOpenSky(v);
                bboxFetchHistory.set(key, Date.now());
                broadcastPlanes(data.states, data.time); // 立即推播 delta
                ingestTrackPoints(data.states, data.time); // [Audit Fix] Ingest high-res adaptive data
                console.log(`🎯 [ADAPTIVE] Portions for ${key} updated. Area: ${area.toFixed(2)}`);
            } catch (e) {
                // console.warn(`[ADAPTIVE] Skip ${key}: ${e.message}`);
            } finally {
                bboxActiveRequests.delete(key);
            }
        })();
        bboxActiveRequests.set(key, p);
    }

    // [v4.3.5] Broadcast adaptive telemetry estimate
    broadcastTelemetry(apiStats, 0);
}

// 保持每 5 秒檢查一次是否有視角需要更新 (實際抓取受分段計時器控制)
setInterval(runAdaptiveViewportPolling, 5000);

// 改寫原本的 fetchGlobalPlanes 為 fetchOpenSky 的封裝
async function fetchGlobalPlanes() {
    if (isFetchingGlobal) return;
    isFetchingGlobal = true;
    try {
        const data = await fetchOpenSky();
        globalPlanesCache = { states: data.states, time: data.time };
        broadcastPlanes(data.states, data.time);
        console.log(`🌏 [GLOBAL] Global snapshot updated: ${data.states.length} planes.`);
    } catch (e) {
        console.error(`❌ [GLOBAL] Error: ${e.message}`);
    }
    isFetchingGlobal = false;

    // [v4.3.5] Broadcast precise global telemetry
    broadcastTelemetry(apiStats, 60);

    // [Audit Fix] Use centralized ingestion helper
    ingestTrackPoints(globalPlanesCache.states, globalPlanesCache.time);
}

// 啟動 60 秒全球資料輪詢機制 (配合 CACHE_TTL=60s)
setInterval(fetchGlobalPlanes, 60000);
// 啟動時讀取快取並初始化
const isFreshQuota = loadQuotaCache();
initializeAccountQuotas(isFreshQuota);

/**
 * 啟動預熱：若帳號沒有額度紀錄，或跨日更新，先各戳一次 API 建立狀態
 */
async function initializeAccountQuotas(isFreshQuota) {
    console.log(`🌐 [QUOTA] Initializing quotas for ${ACCOUNTS.length} accounts...`);
    for (let i = 0; i < ACCOUNTS.length; i++) {
        const acc = apiStats.accounts[i];
        // 如果本地已經有今日的額度紀錄，就不再額外請求
        if (isFreshQuota && acc.remainingCredits !== null) {
            console.log(`✅ [QUOTA] Account ${acc.user} has fresh cached quota: ${acc.remainingCredits}`);
            continue;
        }

        try {
            console.log(`🌐 [QUOTA] Warming up account #${i + 1} (${acc.user})...`);
            // 切換暫時索引來發送請求
            const savedIndex = currentAccountIndex;
            currentAccountIndex = i;

            const headers = await getAuthHeaders();
            // 使用一個極小範圍的 BBox 請求，盡量不耗費太多資源
            const response = await fetch('https://opensky-network.org/api/states/all?lamin=23.5&lomin=120.5&lamax=23.6&lomax=120.6', {
                headers,
                signal: AbortSignal.timeout(10000)
            });

            syncAccountQuota(i, response);
            currentAccountIndex = savedIndex; // 還原

            // 每組間隔一下避免太密集
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            console.error(`❌ [QUOTA] Warm-up failed for ${acc.user}: ${e.message}`);
        }
    }

    // 預熱完後立刻執行一次真正的全球抓取
    fetchGlobalPlanes();
}

// ==========================================
// V2.0.0 BBox Slicer API
// ==========================================
app.get('/api/planes/bbox', (req, res) => {
    let { lamin, lomin, lamax, lomax } = req.query;

    if (!lamin || !lomin || !lamax || !lomax) {
        return res.status(400).json({ error: "Missing BBox parameters" });
    }

    let minLat = parseFloat(lamin);
    let minLng = parseFloat(lomin);
    let maxLat = parseFloat(lamax);
    let maxLng = parseFloat(lomax);

    // 實作 10% Buffer Zone
    const latDiff = maxLat - minLat;
    const lonDiff = maxLng - minLng;

    const bufLamin = minLat - (latDiff * 0.1);
    const bufLamax = maxLat + (latDiff * 0.1);
    const bufLomin = minLng - (lonDiff * 0.1);
    const bufLomax = maxLng + (lonDiff * 0.1);

    // Helper to check if a longitude (-180 to +180) is within the unnormalized BBox [bufLomin, bufLomax]
    const isLngInBounds = (lng, min, max) => {
        if (max - min >= 360) return true; // Box covers whole world
        const center = (min + max) / 2;
        let pLng = lng;
        while (pLng < center - 180) pLng += 360;
        while (pLng > center + 180) pLng -= 360;
        return pLng >= min && pLng <= max;
    };

    // globalPlanesCache.states is an array of pre-parsed objects from workers/parser.js
    const filteredStates = globalPlanesCache.states.filter(p => {
        if (p.lat === null || p.lng === null || p.lat === undefined || p.lng === undefined) return false;
        if (p.lat < bufLamin || p.lat > bufLamax) return false;
        return isLngInBounds(p.lng, bufLomin, bufLomax);
    });

    res.json({
        time: globalPlanesCache.time,
        globalLastUpdate: globalPlanesCache.time, // 用於前端判斷資料是否真正過時
        states: filteredStates,
        totalGlobal: globalPlanesCache.states.length,
        stats: apiStats,
        recommendedInterval: calculateRecommendedInterval()
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
        console.log(`📂 [METADATA STATIC] Loaded ${Object.keys(aircraftStaticDB).length} aircraft from static DB`);
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
        console.log(`📦 [METADATA] Cached to DB: ${icao24} = ${metadata.typecode} ${metadata.model}`);

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

        console.log(`📦 [BATCH] Fetched ${fetched}/${toFetch.length} metadata to MongoDB`);
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

function buildAirportListCache() {
    _cachedAirportList = Object.entries(globalAirportsDB)
        .filter(([key, ap]) => {
            if (ap.icao) return key === ap.icao;
            return key === ap.iata;
        })
        .map(([key, ap]) => ap);
    _cachedAirportListETag = `"${_cachedAirportList.length}-${Date.now()}"`;
    console.log(`✅ [OPT] Airport list cache built: ${_cachedAirportList.length} airports.`);
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

app.get('/api/airports/list', (req, res) => {
    if (!_cachedAirportList) buildAirportListCache();
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
            const nearestAp = findNearestAirport(startLat, startLng, 10);

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
        const points = await TrackPoint.find({ icao24 })
            .sort({ timestamp: 1 })
            .lean();

        const path = points.map(pt => [
            Math.floor(pt.timestamp.getTime() / 1000),
            pt.lat,
            pt.lng,
            pt.altitude,
            pt.heading,
            pt.velocity
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

    // [HOTFIX] 連線狀態守衛：避免在未連線時觸發 Mongoose Buffering 導致 10s 延遲
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ error: 'Database not connected', retryAfter: 30 });
    }

    try {
        // Query local MongoDB Time Series instead of OpenSky
        const points = await TrackPoint.find({ icao24 })
            .sort({ timestamp: 1 })
            .lean();

        // Convert to frontend expected format: [[time, lat, lng, altitude, heading, velocity], ...]
        const path = points.map(pt => [
            Math.floor(pt.timestamp.getTime() / 1000),
            pt.lat,
            pt.lng,
            pt.altitude,
            pt.heading,
            pt.velocity
        ]);

        res.json({ icao24, path });
        console.log(`✅ [TRACKS] Served ${path.length} points from MongoDB for ${icao24}`);
    } catch (error) {
        console.error(`❌ [TRACKS DB ERROR] ${icao24}: ${error.message}`);
        res.status(500).json({ error: 'Database query failed' });
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
        const operations = data.map(info => ({
            updateOne: {
                filter: { icaoId: info.icaoId.toUpperCase() },
                update: { $set: { ...info, lastUpdated: new Date() } },
                upsert: true
            }
        }));

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

// [v2.5.2] SPA Fallback — 未匹配的路由指向 React 前端
app.use((req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public-react', 'index.html'));
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

        // 寫入修正後的路徑
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(newData, null, 2));

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

// 啟動伺服器
const server = http.createServer(app);
initWebSocketServer(server);

server.listen(PORT, () => {
    const readyTime = new Date().toLocaleTimeString();
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   ✈️  AEROSTRAT Surveillance Server      ║');
    console.log(`║   🌐 http://localhost:${PORT}               ║`);
    console.log(`║   📁 Serving: ./public-react             ║`);
    console.log(`║   🔐 Version: v4.2.0                     ║`);
    console.log(`║   ⏱️  Ready: ${readyTime}                 ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
});
