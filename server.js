const express = require('express');
const cors = require('cors');
const path = require('path');
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

const SAFE_RESERVE_CAP = 30; // 每個帳號保留至少 30 次額度，不讓它歸零

async function getAuthHeaders() {
    if (ACCOUNTS.length === 0) return {};

    // 檢查目前帳號是否還有足夠的安全餘額
    const currentStats = apiStats.accounts[currentAccountIndex];
    if (currentStats.remainingCredits !== null && currentStats.remainingCredits <= SAFE_RESERVE_CAP) {
        // 如果目前帳號正在冷卻中就不特別處理（交由後續 429 機制），
        // 否則如果還在 ACTIVE 但餘額不足，嘗試主動輪替
        const isCurrentlyLimited = currentStats.unlockTime && new Date(currentStats.unlockTime).getTime() > Date.now();
        if (!isCurrentlyLimited) {
            console.log(`🛡️ [RESERVE] Account ${ACCOUNTS[currentAccountIndex].user} hit safe floor (${currentStats.remainingCredits}). Rotating preemptively...`);
            if (rotateAccount()) {
                return await getAuthHeaders();
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
            if (rotateAccount()) return await getAuthHeaders();
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
// API 路由
// ==========================================

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

// 取得飛機狀態（代理 OpenSky /states/all）
const activeRequests = new Map();
let globalRateLimitCooldown = 0; // The timestamp when we are allowed to ping OpenSky again

app.get('/api/states', async (req, res) => {
    const { lamin, lomin, lamax, lomax } = req.query;

    const isGlobal = !lamin || !lomin || !lamax || !lomax;
    const cacheKey = isGlobal
        ? 'states_global'
        : `states_${parseFloat(lamin).toFixed(1)}_${parseFloat(lomin).toFixed(1)}_${parseFloat(lamax).toFixed(1)}_${parseFloat(lomax).toFixed(1)}`;

    // 檢查全域封鎖倒數定時器 (Global 429 Cooldown)
    if (Date.now() < globalRateLimitCooldown) {
        console.log(`⏳ [GLOBAL COOLDOWN] OpenSky Daily Limits reached. Sleeping for ${Math.round((globalRateLimitCooldown - Date.now()) / 1000)}s...`);
        const cached = getCached(cacheKey);
        if (cached && cached.states) {
            return res.json({ time: Date.now(), states: cached.states, stats: apiStats, recommendedInterval: calculateRecommendedInterval(), stale: true });
        }
        return res.status(429).json({ error: "Rate Limited", stats: apiStats, recommendedInterval: calculateRecommendedInterval() });
    }

    // 檢查快取
    const cached = getCached(cacheKey);
    if (cached) {
        console.log(`✅ [CACHE HIT] ${cacheKey}`);
        return res.json({ time: Date.now(), states: cached.states, stats: apiStats, recommendedInterval: calculateRecommendedInterval() });
    }

    if (activeRequests.has(cacheKey)) {
        console.log(`⏳ [STAMPEDE PREVENT] Waiting for existing request for ${cacheKey}...`);
        try {
            const data = await activeRequests.get(cacheKey);
            return res.json({ time: Date.now(), states: data.states, stats: apiStats, recommendedInterval: calculateRecommendedInterval() });
        } catch (error) {
            // failed, fall through to stale cache below
        }
    } else {
        const fetchPromise = (async () => {
            let retries = ACCOUNTS.length;
            let lastError = null;

            while (retries > 0) {
                try {
                    const url = isGlobal
                        ? `https://opensky-network.org/api/states/all`
                        : `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;

                    console.log(`🌐 [API CALL] Fetching states... (Account: ${ACCOUNTS[currentAccountIndex].user})`);
                    apiStats.totalCalls++;
                    apiStats.stateCalls++;

                    const headers = await getAuthHeaders();
                    const response = await fetch(url, {
                        headers,
                        signal: AbortSignal.timeout(18000)
                    });

                    if (!response.ok) {
                        const errorText = await response.text();

                        if (response.status === 429) {
                            console.warn(`⚠️ [RATE LIMIT] Account ${ACCOUNTS[currentAccountIndex].user} limited. Rotating...`);
                            apiStats.accounts[currentAccountIndex].rateLimits++;

                            const retryStr = response.headers.get('x-rate-limit-retry-after-seconds');
                            if (retryStr) {
                                apiStats.accounts[currentAccountIndex].unlockTime = new Date(Date.now() + parseInt(retryStr, 10) * 1000).toISOString();
                            }

                            if (retries > 1 && rotateAccount()) {
                                retries--;
                                continue; // Retry loop with new account
                            } else {
                                const penaltySeconds = retryStr ? parseInt(retryStr, 10) : 5 * 60;
                                globalRateLimitCooldown = Date.now() + (penaltySeconds * 1000);
                                console.error(`🛑 [FATAL] ALL OPEN SKY ACCOUNTS RATE LIMITED. Halting requests for ${penaltySeconds} seconds.`);
                                throw new Error(`All accounts exhausted. Resumes in ${penaltySeconds}s`);
                            }
                        }

                        throw new Error(`OpenSky API error: ${response.status} ${errorText.substring(0, 100)}`);
                    }

                    const remainingStr = response.headers.get('x-rate-limit-remaining');
                    if (remainingStr) {
                        const remainingNum = parseInt(remainingStr, 10);
                        apiStats.accounts[currentAccountIndex].remainingCredits = remainingNum;
                        // 如果成功獲得 quota，就清空這個帳號的解鎖時間
                        apiStats.accounts[currentAccountIndex].unlockTime = null;

                        // [PROACTIVE ROTATION] 如果請求完發現剩餘額度已破底線，下次請求前先換帳號
                        if (remainingNum <= SAFE_RESERVE_CAP && retries > 1) {
                            console.log(`🛡️ [RESERVE] Post-call check: Account ${ACCOUNTS[currentAccountIndex].user} is low (${remainingNum}). Rotating...`);
                            rotateAccount();
                        }
                    }

                    const data = await response.json();
                    apiStats.lastSuccessTime = new Date().toISOString();

                    // 存入快取
                    setCache(cacheKey, data);
                    console.log(`📦 [CACHED] ${cacheKey} | States: ${data.states ? data.states.length : 0}`);

                    return data;

                } catch (error) {
                    lastError = error;
                    console.error(`❌ [FETCH ERROR] ${error.message}`);
                    if (error.message.includes('All accounts')) break;
                    if (!error.message.includes('Rate limited')) {
                        break;
                    }
                    retries--;
                    if (retries <= 0) break;
                }
            }

            apiStats.errors++;
            apiStats.lastError = lastError ? lastError.message : 'Unknown error';
            apiStats.lastErrorTime = new Date().toISOString();
            throw lastError || new Error('Unknown error');
        })();

        activeRequests.set(cacheKey, fetchPromise);

        try {
            const data = await fetchPromise;
            activeRequests.delete(cacheKey);
            return res.json({ time: Date.now(), states: data.states, stats: apiStats, recommendedInterval: calculateRecommendedInterval() });
        } catch (err) {
            activeRequests.delete(cacheKey);
            // fail through to stale cache
        }
    }

    // 終極備援：如果 API 超時斷線，嘗試回傳舊的快取資料 (即使已經過期)，避免前端飛機全部消失
    const entry = cache.get(cacheKey);
    if (entry && entry.data) {
        console.log(`⚠️ [STALE CACHE] Returning outdated ${cacheKey} due to fetch error.`);
        return res.json({ time: Date.now(), states: entry.data.states, stats: apiStats, stale: true });
    }

    res.status(429).json({ error: 'Rate limited on all accounts or API error.', detail: apiStats.lastError, stats: apiStats });
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
// 飛機 Metadata（機型/製造商/註冊號）— 永久快取
// ==========================================
const fs = require('fs');
const METADATA_CACHE_FILE = path.join(__dirname, 'aircraft-cache.json');
let aircraftMetadataCache = {};

// 啟動時載入快取檔案
try {
    if (fs.existsSync(METADATA_CACHE_FILE)) {
        aircraftMetadataCache = JSON.parse(fs.readFileSync(METADATA_CACHE_FILE, 'utf8'));
        console.log(`📂 [METADATA] Loaded ${Object.keys(aircraftMetadataCache).length} cached aircraft`);
    }
} catch (e) {
    console.warn('⚠️ Failed to load metadata cache:', e.message);
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

    // 檢查永久快取
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
            // 記錄為「無資料」避免重複查詢
            aircraftMetadataCache[icao24] = { icao24, noData: true };
            saveMetadataCache();
            return res.json(aircraftMetadataCache[icao24]);
        }

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
        return !aircraftMetadataCache[id.toLowerCase()];
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
                apiStats.rateLimits++;
                apiStats.lastError = '429 Rate Limited (metadata batch)';
                apiStats.lastErrorTime = new Date().toISOString();
                break; // 停止批次查詢
            }

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
let routesDatabase = {};
let localRoutesDB = {}; // Ultimate Offline Dictionary

try {
    if (fs.existsSync(ROUTES_CACHE_FILE)) {
        routesDatabase = JSON.parse(fs.readFileSync(ROUTES_CACHE_FILE, 'utf8'));
        console.log(`🗺️ [ROUTE DB] Loaded ${Object.keys(routesDatabase).length} routes from cache`);
    }
    if (fs.existsSync(LOCAL_ROUTES_FILE)) {
        localRoutesDB = JSON.parse(fs.readFileSync(LOCAL_ROUTES_FILE, 'utf8'));
        console.log(`🗺️ [LOCAL ROUTES] Loaded ${Object.keys(localRoutesDB).length} routes from static dictionary`);
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

app.get('/api/route/:icao24', async (req, res) => {
    const icao24 = req.params.icao24.toLowerCase();
    const callsign = req.query.callsign ? req.query.callsign.trim().toUpperCase() : '';

    // 1. 極致靜態優先 (Ultimate Static Route Bypassing API)
    // 優先檢查我們在 data/local_routes.json 中定義的無延遲靜態航班表
    if (callsign && localRoutesDB[callsign]) {
        console.log(`🗺️ [STATIC DICT DB] Hit for ${callsign}: ${localRoutesDB[callsign][0]} -> ${localRoutesDB[callsign][1]}`);
        return res.json({
            icao24,
            callsign,
            departureAirport: localRoutesDB[callsign][0], // IATA directly
            arrivalAirport: localRoutesDB[callsign][1],
            fromStaticDB: true,
            isIata: true
        });
    }

    if (callsign && routesDatabase[callsign]) {
        console.log(`🗺️ [ROUTE DB] Local hit for ${callsign}: ${routesDatabase[callsign].dep} -> ${routesDatabase[callsign].arr}`);
        return res.json({
            icao24,
            callsign,
            departureAirport: routesDatabase[callsign].dep,
            arrivalAirport: routesDatabase[callsign].arr,
            fromStaticDB: true
        });
    }



    // 2. 檢查記憶體動態快取
    const cached = routeCache.get(icao24);
    if (cached && (Date.now() - cached.timestamp < ROUTE_CACHE_TTL)) {
        return res.json(cached.data);
    }

    try {
        // 3. 嘗試使用 OpenSky 輕量化 Route API (使用 callsign 取得表定航線)
        if (callsign) {
            console.log(`✈️ [ROUTE] Fetching static route for callsign: ${callsign}...`);
            const url = `https://api.opensky-network.org/api/routes?callsign=${callsign}`;
            const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

            if (response.ok) {
                const routeData = await response.json();
                if (routeData && routeData.route && routeData.route.length >= 2) {
                    routesDatabase[callsign] = {
                        dep: routeData.route[0],
                        arr: routeData.route[1]
                    };
                    saveRoutesDatabase();
                    console.log(`📦 [ROUTE DB] Cached new scheduled route: ${callsign} -> ${routesDatabase[callsign].dep}-${routesDatabase[callsign].arr}`);

                    const result = {
                        icao24,
                        callsign,
                        departureAirport: routeData.route[0],
                        arrivalAirport: routeData.route[1],
                        fromStaticDB: false
                    };
                    routeCache.set(icao24, { data: result, timestamp: Date.now() });
                    return res.json(result);
                }
            }
        }

        // 4. 重度回退：如果 API 找不到表定航班，使用原來的 flights/aircraft 抓這台飛機過去 24 小時紀錄
        console.log(`✈️ [ROUTE] Fallback to historical flight for ${icao24}...`);
        const now = Math.floor(Date.now() / 1000);
        const begin = now - 86400; // 過去 24 小時
        const url = `https://opensky-network.org/api/flights/aircraft?icao24=${icao24}&begin=${begin}&end=${now}`;

        const headers = await getAuthHeaders();
        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            if (response.status === 429) {
                return res.json({ icao24, callsign, noData: true, reason: 'rate_limited' });
            }
            return res.json({ icao24, callsign, noData: true });
        }

        const flights = await response.json();

        let latest = null;
        if (flights && flights.length > 0) {
            latest = flights.reverse().find(f => f.estDepartureAirport || f.estArrivalAirport) || flights[0];
        }

        let dep = latest ? latest.estDepartureAirport : null;
        let arr = latest ? latest.estArrivalAirport : null;

        if (!dep || !arr) {
            const noDataResult = { icao24, callsign, noData: true };
            routeCache.set(icao24, { data: noDataResult, timestamp: Date.now() });
            return res.json(noDataResult);
        }

        // 5. 將所有成功取得的歷史紀錄，無條件寫入終極靜態庫，實現全域永久靜態化
        if (!routesDatabase[callsign]) {
            routesDatabase[callsign] = { dep, arr };
            saveRoutesDatabase();
            console.log(`📦 [ROUTE DB] Saved historical route to static dictionary: ${callsign} -> ${dep}-${arr}`);
        }

        const routeData = {
            icao24,
            callsign: (latest.callsign || callsign).trim(),
            departureAirport: dep,
            arrivalAirport: arr,
            firstSeen: latest.firstSeen,
            lastSeen: latest.lastSeen,
            fromHistorical: true
        };

        routeCache.set(icao24, { data: routeData, timestamp: Date.now() });
        console.log(`✈️ [ROUTE] Historical fallback ${icao24}: ${routeData.departureAirport} → ${routeData.arrivalAirport}`);
        res.json(routeData);

    } catch (error) {
        console.error(`❌ [ROUTE ERROR] ${icao24} (${callsign}): ${error.message}`);
        res.json({ icao24, callsign, noData: true, error: error.message });
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
// 啟動伺服器
// ==========================================
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   ✈️  Flight Radar Backend Server        ║');
    console.log(`║   🌐 http://localhost:${PORT}               ║`);
    console.log(`║   📁 Serving: ./public-react             ║`);
    console.log(`║   🔑 Auth: ${process.env.OPENSKY_USER ? 'Enabled' : 'Disabled (no credentials)'}             ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
});
