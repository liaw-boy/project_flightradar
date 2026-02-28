const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { Worker } = require('worker_threads');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Middleware
// ==========================================
app.use(cors());
app.use(express.json());
// 提供前端靜態檔案
app.use(express.static(path.join(__dirname, 'public-react'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
})); // React build
app.use(express.static(path.join(__dirname, 'public')));        // 舊版 HTML

// ==========================================
// 快取系統
// ==========================================
const cache = new Map();
const CACHE_TTL = 8000; // 8 秒快取（配合前端快速輪詢）

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
        fs.writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(apiStats.accounts, null, 2));
    } catch (e) {
        console.error('❌ [QUOTA] Failed to save quota cache:', e.message);
    }
}

function loadQuotaCache() {
    try {
        if (fs.existsSync(QUOTA_CACHE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(QUOTA_CACHE_FILE, 'utf8'));
            // 根據使用者名稱比對，恢復狀態
            apiStats.accounts.forEach(acc => {
                const found = saved.find(s => s.user === acc.user);
                if (found) {
                    acc.remainingCredits = found.remainingCredits;
                    acc.unlockTime = found.unlockTime;
                    acc.rateLimits = found.rateLimits || 0;
                }
            });
            console.log(`💾 [QUOTA] Loaded persistent stats for ${apiStats.accounts.length} accounts.`);
        }
    } catch (e) {
        console.error('❌ [QUOTA] Failed to load quota cache:', e.message);
    }
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
// V2.0.0 Global Polling System & BBox API
// ==========================================
let globalPlanesCache = { states: [], time: 0 };
let isFetchingGlobal = false;
let globalRateLimitCooldown = 0; // The timestamp when we are allowed to ping OpenSky again

// 背景持續輪詢 OpenSky 取得全球資料
async function fetchGlobalPlanes() {
    if (isFetchingGlobal) return;
    if (Date.now() < globalRateLimitCooldown) {
        console.log(`⏳ [GLOBAL COOLDOWN] Skipping fetch. Resting for ${Math.round((globalRateLimitCooldown - Date.now()) / 1000)}s...`);
        return;
    }

    isFetchingGlobal = true;
    let retries = ACCOUNTS.length;

    while (retries > 0) {
        try {
            const headers = await getAuthHeaders();

            // 重要：在確定最終選用的帳號後再進行 Log，避免誤導
            console.log(`🌐 [GLOBAL FETCH] Requesting /states/all ... (Account: ${ACCOUNTS[currentAccountIndex].user})`);
            apiStats.totalCalls++;
            apiStats.stateCalls++;
            const response = await fetch('https://opensky-network.org/api/states/all', {
                headers,
                signal: AbortSignal.timeout(18000)
            });

            if (!response.ok) {
                const errorText = await response.text();

                // 同步 Quota (即使失敗也可能有 Header)
                syncAccountQuota(currentAccountIndex, response);

                if (response.status === 429) {
                    console.warn(`⚠️ [RATE LIMIT] Account ${ACCOUNTS[currentAccountIndex].user} limited. Rotating...`);

                    if (retries > 1 && rotateAccount()) {
                        retries--;
                        continue;
                    } else {
                        const retryStr = response.headers.get('x-rate-limit-retry-after-seconds');
                        const penaltySeconds = retryStr ? parseInt(retryStr, 10) : 5 * 60;
                        globalRateLimitCooldown = Date.now() + (penaltySeconds * 1000);
                        throw new Error(`All accounts exhausted. Resumes in ${penaltySeconds}s`);
                    }
                }
                throw new Error(`OpenSky API error: ${response.status} ${errorText.substring(0, 50)}`);
            }

            // 更新 Quota
            syncAccountQuota(currentAccountIndex, response);

            const remaining = apiStats.accounts[currentAccountIndex].remainingCredits;
            if (remaining !== null && remaining <= SAFE_RESERVE_CAP && retries > 1) {
                console.log(`🛡️ [RESERVE] Post-call check: Account ${ACCOUNTS[currentAccountIndex].user} metric low. Rotating...`);
                rotateAccount();
            }

            // [V2.0.0] 將龐大的 JSON.stringify 文字交給 Worker Thread 處理
            const rawJsonText = await response.text();

            const worker = new Worker(path.join(__dirname, 'workers', 'parser.js'));
            worker.postMessage(rawJsonText);

            worker.on('message', (msg) => {
                if (msg.success) {
                    globalPlanesCache = { states: msg.planes, time: msg.time };
                    console.log(`📦 [WORKER] Parse complete. Parsed ${msg.planes.length} planes in ${msg.parseTimeMs}ms.`);
                    apiStats.lastSuccessTime = new Date().toISOString();
                } else {
                    console.error(`❌ [WORKER ERROR] ${msg.error}`);
                }
                worker.terminate();
            });

            worker.on('error', (err) => {
                console.error(`❌ [WORKER FATAL] ${err.message}`);
            });

            break; // 成功取得並派發給 Worker 後跳出重試迴圈

        } catch (error) {
            console.error(`❌ [FETCH ERROR] ${error.message}`);
            if (error.message.includes('All accounts') || !error.message.includes('Rate limited')) break;
            retries--;
        }
    }

    isFetchingGlobal = false;
}

// 啟動 20 秒全球資料輪詢機制 (User Specified: 20s)
setInterval(fetchGlobalPlanes, 20000);
// 啟動時讀取快取並初始化
loadQuotaCache();
initializeAccountQuotas();

/**
 * 啟動預熱：若帳號沒有額度紀錄，先各戳一次 API 建立狀態
 */
async function initializeAccountQuotas() {
    console.log(`🌐 [QUOTA] Initializing quotas for ${ACCOUNTS.length} accounts...`);
    for (let i = 0; i < ACCOUNTS.length; i++) {
        const acc = apiStats.accounts[i];
        // 如果本地已經有額度紀錄，就不再額外請求 (User Request: skip if record exists)
        if (acc.remainingCredits !== null) {
            console.log(`✅ [QUOTA] Account ${acc.user} has cached quota: ${acc.remainingCredits}`);
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

    // Filter `globalPlanesCache`
    const filteredStates = globalPlanesCache.states.filter(p => {
        return p.lat >= bufLamin && p.lat <= bufLamax && p.lng >= bufLomin && p.lng <= bufLomax;
    });

    res.json({
        time: globalPlanesCache.time,
        globalLastUpdate: globalPlanesCache.time, // 用於前端判斷資料是否真正過時
        states: filteredStates,
        totalGlobal: globalPlanesCache.states.length,
        stats: apiStats,
        recommendedInterval: 25
    });
});

// 取得飛行軌跡（代理 OpenSky /tracks/all）
app.get('/api/tracks', async (req, res) => {
    const { icao24 } = req.query;

    if (!icao24) {
        return res.status(400).json({ error: 'Missing required parameter: icao24' });
    }

    const cacheKey = `track_${icao24}`;
    const cached = getCached(cacheKey);
    if (cached) {
        console.log(`✅ [CACHE HIT] Track: ${icao24}`);
        return res.json(cached);
    }

    try {
        const url = `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`;

        console.log(`🌐 [API CALL] Fetching track for ${icao24}...`);
        const headers = await getAuthHeaders();
        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            if (response.status === 404) {
                return res.status(404).json({ error: 'Track not found for this aircraft' });
            }
            return res.status(response.status).json({ error: `OpenSky API error: ${response.status}` });
        }

        const data = await response.json();
        setCache(cacheKey, data);
        console.log(`📦 [CACHED] Track: ${icao24} | Points: ${data.path ? data.path.length : 0}`);

        res.json(data);
    } catch (error) {
        console.error(`❌ [FETCH ERROR] Track ${icao24}: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch track data', detail: error.message });
    }
});

// ==========================================
// 飛機 Metadata（機型/製造商/註冊號）— 永久快取與靜態字典
// ==========================================
const METADATA_CACHE_FILE = path.join(__dirname, 'aircraft-cache.json');
const AIRCRAFT_STATIC_FILE = path.join(__dirname, 'data', 'aircraft_static.json');
let aircraftMetadataCache = {};
let aircraftStaticDB = {};

// 啟動時載入快取檔案
try {
    if (fs.existsSync(METADATA_CACHE_FILE)) {
        aircraftMetadataCache = JSON.parse(fs.readFileSync(METADATA_CACHE_FILE, 'utf8'));
        console.log(`📂 [METADATA] Loaded ${Object.keys(aircraftMetadataCache).length} cached aircraft`);
    }
    if (fs.existsSync(AIRCRAFT_STATIC_FILE)) {
        aircraftStaticDB = JSON.parse(fs.readFileSync(AIRCRAFT_STATIC_FILE, 'utf8'));
        console.log(`📂 [METADATA STATIC] Loaded ${Object.keys(aircraftStaticDB).length} aircraft from static DB`);
    }
} catch (e) {
    console.warn('⚠️ Failed to load metadata files:', e.message);
}

function saveMetadataCache() {
    try {
        fs.writeFileSync(METADATA_CACHE_FILE, JSON.stringify(aircraftMetadataCache), 'utf8');
    } catch (e) {
        console.warn('⚠️ Failed to save metadata cache:', e.message);
    }
}

app.get('/api/metadata/:icao24', async (req, res) => {
    const icao24 = req.params.icao24.toLowerCase();

    // 1. 優先檢查靜態字典 (Static First)
    if (aircraftStaticDB[icao24]) {
        console.log(`📦 [METADATA STATIC HIT] ${icao24}`);
        return res.json({ ...aircraftStaticDB[icao24], fromStatic: true });
    }

    // 2. 檢查永久快取
    if (aircraftMetadataCache[icao24]) {
        return res.json(aircraftMetadataCache[icao24]);
    }

    try {
        const url = `https://opensky-network.org/api/metadata/aircraft/icao/${icao24}`;
        console.log(`🌐 [METADATA] Fetching metadata for ${icao24}...`);
        const headers = await getAuthHeaders();
        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            syncAccountQuota(currentAccountIndex, response);
            // 記錄為「無資料」避免重複查詢
            aircraftMetadataCache[icao24] = { icao24, noData: true };
            saveMetadataCache();
            return res.json(aircraftMetadataCache[icao24]);
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
            operator: data.operatorCallsign || '',
            built: data.built || '',
            categoryDescription: data.categoryDescription || ''
        };

        aircraftMetadataCache[icao24] = metadata;
        saveMetadataCache();
        console.log(`📦 [METADATA] Cached: ${icao24} = ${metadata.typecode} ${metadata.model}`);

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
    var icao24List = req.body.icao24s || [];

    // 過濾已快取的
    var uncached = icao24List.filter(function (id) {
        const key = id.toLowerCase();
        return !aircraftMetadataCache[key] && !aircraftStaticDB[key];
    });

    if (uncached.length === 0) {
        return res.json({ fetched: 0, total: Object.keys(aircraftMetadataCache).length });
    }

    // 最多同時查詢 10 架，避免限流
    var toFetch = uncached.slice(0, 10);
    var fetched = 0;

    for (var i = 0; i < toFetch.length; i++) {
        var icao24 = toFetch[i].toLowerCase();
        try {
            var headers = await getAuthHeaders();
            apiStats.totalCalls++;
            apiStats.metadataCalls++;
            var response = await fetch(
                'https://opensky-network.org/api/metadata/aircraft/icao/' + icao24,
                { headers, signal: AbortSignal.timeout(8000) }
            );

            if (response.status === 429) {
                syncAccountQuota(currentAccountIndex, response);
                apiStats.rateLimits++;
                apiStats.lastError = '429 Rate Limited (metadata batch)';
                apiStats.lastErrorTime = new Date().toISOString();
                break; // 停止批次查詢
            }

            syncAccountQuota(currentAccountIndex, response);

            if (response.ok) {
                var data = await response.json();
                aircraftMetadataCache[icao24] = {
                    icao24: icao24,
                    registration: data.registration || '',
                    manufacturerName: data.manufacturerName || '',
                    model: data.model || '',
                    typecode: data.typecode || '',
                    owner: data.owner || '',
                    operator: data.operatorCallsign || '',
                    built: data.built || '',
                    categoryDescription: data.categoryDescription || ''
                };
                fetched++;
                apiStats.lastSuccessTime = new Date().toISOString();
            } else {
                aircraftMetadataCache[icao24] = { icao24: icao24, noData: true };
            }
        } catch (e) {
            aircraftMetadataCache[icao24] = { icao24: icao24, noData: true };
            apiStats.errors++;
        }

        // 每查一架等 300ms，避免限流
        if (i < toFetch.length - 1) {
            await new Promise(function (r) { setTimeout(r, 300); });
        }
    }

    saveMetadataCache();
    console.log(`📦 [BATCH] Fetched ${fetched}/${toFetch.length} metadata | Cache: ${Object.keys(aircraftMetadataCache).length}`);

    res.json({
        fetched: fetched,
        requested: toFetch.length,
        remaining: uncached.length - toFetch.length,
        total: Object.keys(aircraftMetadataCache).length
    });
});

// ==========================================
// 航班來源/目的地 API (flights/aircraft & routes)
// 實作: 固定航班航線字典 (Flight Route Database)
// ==========================================
const ROUTES_CACHE_FILE = path.join(__dirname, 'routes-cache.json');
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

loadGlobalData();

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
    if (fs.existsSync(ROUTES_CACHE_FILE)) {
        routesDatabase = JSON.parse(fs.readFileSync(ROUTES_CACHE_FILE, 'utf8'));
        console.log(`🗺️ [ROUTE DB] Loaded ${Object.keys(routesDatabase).length} routes from cache`);
    }
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

function saveRoutesDatabase() {
    try {
        fs.writeFileSync(ROUTES_CACHE_FILE, JSON.stringify(routesDatabase, null, 2));
    } catch (e) {
        console.error('❌ Error saving routes-cache.json:', e.message);
    }
}

const routeCache = new Map(); // icao24 -> { data, timestamp } (動態航線快取)
const ROUTE_CACHE_TTL = 1800000; // 30 分鐘

app.get('/api/airports/list', (req, res) => {
    // Return all unique airports (key == icao or if no icao, key == iata)
    // To avoid double-sending (as dictionary has both icao and iata as keys)
    const airportList = Object.entries(globalAirportsDB)
        .filter(([key, ap]) => {
            if (ap.icao) return key === ap.icao;
            return key === ap.iata;
        })
        .map(([key, ap]) => ap);

    console.log(`🌐 [API] Serving ${airportList.length} airports to client (Global Search/Display)`);
    res.json(airportList);
});

app.get('/api/airport/:code', (req, res) => {
    const code = req.params.code.toUpperCase();

    // Check Global Database first
    if (globalAirportsDB[code]) {
        return res.json(globalAirportsDB[code]);
    }

    // Check METAR cache (Fallback)
    if (metarCache.data) {
        const metarAirport = metarCache.data.find(m => m.icaoId === code || m.iataId === code);
        if (metarAirport) {
            return res.json({
                icao: metarAirport.icaoId,
                iata: metarAirport.iataId,
                name: metarAirport.name,
                city: metarAirport.city,
                country: metarAirport.country,
                lat: metarAirport.lat,
                lon: metarAirport.lon,
                source: 'metar_cache'
            });
        }
    }

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
        if (routesDatabase[cs]) {
            route = routesDatabase[cs];
            matchSource = 'cache';
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

        // Fetch tracks history to find the starting point
        const trackRes = await fetch(`http://localhost:${PORT}/api/tracks?icao24=${icao24}`);
        const trackData = await trackRes.json();

        if (trackData && trackData.path && trackData.path.length > 0) {
            const startPoint = trackData.path[0]; // [time, lat, lng, alt, heading, onGround]
            const startLat = startPoint[1];
            const startLng = startPoint[2];

            // Find nearest airport within 10km
            let nearestAp = null;
            let minDict = 10; // 門檻 10km

            // 我們優化搜尋，僅對有 ICAO 代碼的真實機場進行比對
            for (const ap of Object.values(globalAirportsDB)) {
                if (!ap.icao || !ap.lat || !ap.lng) continue;
                const dist = getDistance(startLat, startLng, ap.lat, ap.lng);
                if (dist < minDict) {
                    minDict = dist;
                    nearestAp = ap;
                }
            }

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
// 飛機軌跡 Tracks API (過去 24 小時的飛行路徑)
// ==========================================
const trackCache = new Map();
const TRACK_CACHE_TTL = 30000; // 30 秒快取

app.get('/api/tracks', async (req, res) => {
    const icao24 = req.query.icao24;
    const time = req.query.time || 0;
    if (!icao24) return res.status(400).json({ error: 'Missing icao24' });

    // 檢查快取
    const cached = trackCache.get(icao24);
    if (cached && (Date.now() - cached.timestamp < TRACK_CACHE_TTL)) {
        return res.json(cached.data);
    }

    try {
        console.log(`🗺️ [TRACKS] Fetching track history for ${icao24} at t=${time}...`);
        const headers = await getAuthHeaders();
        const url = `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=${time}`;

        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            let msg = response.statusText;
            if (response.status === 429) msg = 'Rate Limited (429)';
            if (response.status === 404) {
                msg = 'Flight not currently tracked (404)';
                // Cache the 404 so we don't spam OpenSky for dead flights
                trackCache.set(icao24, { data: { icao24, path: [], noData: true, error: msg }, timestamp: Date.now() });
            }
            console.warn(`⚠️ [TRACKS ERROR] ${icao24} failed: ${response.status} ${msg}`);
            return res.json({ icao24, path: [], noData: true, error: msg });
        }

        const data = await response.json();
        const result = { icao24, path: data.path || [] };

        // 存入快取
        trackCache.set(icao24, { data: result, timestamp: Date.now() });
        console.log(`✅ [TRACKS] Fetched ${result.path.length} waypoints for ${icao24}`);

        res.json(result);
    } catch (error) {
        console.error(`❌ [TRACKS ERROR] ${icao24}: ${error.message}`);
        res.json({ icao24, path: [], noData: true, error: error.message });
    }
});

// ==========================================
// METAR 機場天氣 API (每小時更新)
// ==========================================
const METAR_CACHE_FILE = path.join(__dirname, 'metar-cache.json');
const METAR_TTL = 3600000; // 1 小時
let metarCache = { timestamp: 0, data: [] };

// 啟動時讀取快取
try {
    if (fs.existsSync(METAR_CACHE_FILE)) {
        metarCache = JSON.parse(fs.readFileSync(METAR_CACHE_FILE, 'utf8'));
        console.log(`📡 [METAR] Loaded ${metarCache.data.length} airport weather records from cache`);
    }
} catch (e) { /* ignore */ }

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
        metarCache = { timestamp: Date.now(), data };

        // 寫入檔案快取
        fs.writeFileSync(METAR_CACHE_FILE, JSON.stringify(metarCache, null, 2));
        console.log(`📡 [METAR] Updated ${data.length} airport weather records`);
    } catch (error) {
        console.error('❌ [METAR] Fetch error:', error.message);
    }
}

// 啟動時抓取 (如果快取過期)
if (Date.now() - metarCache.timestamp > METAR_TTL) {
    fetchMetarData();
} else {
    const cachedTime = new Date(metarCache.timestamp).toLocaleTimeString();
    console.log(`📡 [METAR] System ready. Using cached weather data from ${cachedTime}.`);
}

// 每小時定時更新
setInterval(fetchMetarData, METAR_TTL);

app.get('/api/metar', (req, res) => {
    const icao = req.query.icao;
    if (icao) {
        const found = metarCache.data.find(m => m.icaoId === icao.toUpperCase());
        return res.json(found || { error: 'Airport not found' });
    }
    res.json(metarCache.data);
});

// ==========================================
// SPA Fallback — 未匹配的路由指向 React 前端
// ==========================================
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
        const SCHEDULE_FILE = path.join(__dirname, 'schedules_static.json');

        // [轉譯與覆寫]
        // 原則上我們直接覆寫，但如果是 CSV 或其他格式，這裡需要加入清洗邏輯
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(newData, null, 2));

        // 同步完成後更新記憶體中的變數
        global.schedulesStaticDB = newData;

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
app.listen(PORT, () => {
    const readyTime = new Date().toLocaleTimeString();
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   ✈️  Flight Radar Backend Server        ║');
    console.log(`║   🌐 http://localhost:${PORT}               ║`);
    console.log(`║   📁 Serving: ./public-react             ║`);
    console.log(`║   🔑 Auth: ${process.env.OPENSKY_USER ? 'Enabled' : 'Disabled'}                    ║`);
    console.log(`║   ⏱️  Ready: ${readyTime}                 ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
});
