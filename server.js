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
        cache.delete(key);
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
    { user: process.env.OPENSKY_USER2, pass: process.env.OPENSKY_PASS2 }
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

async function getAuthHeaders() {
    if (ACCOUNTS.length === 0) return {};

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
    rateLimits: 0,
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
        rateLimits: apiStats.rateLimits,
        errors: apiStats.errors,
        lastError: apiStats.lastError,
        lastErrorTime: apiStats.lastErrorTime,
        lastSuccessTime: apiStats.lastSuccessTime,
        uptimeMinutes: Math.round((Date.now() - apiStats.startTime) / 60000),
        metadataCacheSize: Object.keys(aircraftMetadataCache).length,
        activeAccount: ACCOUNTS.length > 0 ? `${currentAccountIndex + 1}/${ACCOUNTS.length} (${ACCOUNTS[currentAccountIndex].user})` : 'none'
    });
});

// 取得飛機狀態（代理 OpenSky /states/all）
app.get('/api/states', async (req, res) => {
    const { lamin, lomin, lamax, lomax } = req.query;

    const isGlobal = !lamin || !lomin || !lamax || !lomax;
    const cacheKey = isGlobal
        ? 'states_global'
        : `states_${parseFloat(lamin).toFixed(1)}_${parseFloat(lomin).toFixed(1)}_${parseFloat(lamax).toFixed(1)}_${parseFloat(lomax).toFixed(1)}`;

    // 檢查快取
    const cached = getCached(cacheKey);
    if (cached) {
        console.log(`✅ [CACHE HIT] ${cacheKey}`);
        return res.json(cached);
    }

    // 嘗試請求（支援失敗重試與帳號輪替）
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
                signal: AbortSignal.timeout(15000)
            });

            if (!response.ok) {
                const errorText = await response.text();

                // 429 Rate Check -> Rotate and Retry
                if (response.status === 429) {
                    console.warn(`⚠️ [RATE LIMIT] Account ${ACCOUNTS[currentAccountIndex].user} limited. Rotating...`);
                    apiStats.rateLimits++;

                    if (rotateAccount()) {
                        retries--;
                        continue; // Retry loop with new account
                    } else {
                        // No more accounts to rotate
                        throw new Error('All accounts rate limited');
                    }
                }

                throw new Error(`OpenSky API error: ${response.status} ${errorText.substring(0, 100)}`);
            }

            const data = await response.json();
            apiStats.lastSuccessTime = new Date().toISOString();

            // 存入快取
            setCache(cacheKey, data);
            console.log(`📦 [CACHED] ${cacheKey} | States: ${data.states ? data.states.length : 0}`);

            return res.json(data); // Success!

        } catch (error) {
            lastError = error;
            console.error(`❌ [FETCH ERROR] ${error.message}`);
            // If it was not a 429 (handled above), we might not want to retry, but let's be safe and fail out if not 429
            if (!error.message.includes('Rate limited') && !error.message.includes('All accounts')) {
                break;
            }
            if (retries <= 0) break;
        }
    }

    // All retries failed
    apiStats.errors++;
    apiStats.lastError = lastError ? lastError.message : 'Unknown error';
    apiStats.lastErrorTime = new Date().toISOString();
    res.status(429).json({ error: 'Rate limited on all accounts or API error.', detail: apiStats.lastError });
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
// 航班來源/目的地 API (flights/aircraft)
// ==========================================
const routeCache = new Map(); // icao24 -> { data, timestamp }
const ROUTE_CACHE_TTL = 1800000; // 30 分鐘

app.get('/api/route/:icao24', async (req, res) => {
    const icao24 = req.params.icao24.toLowerCase();

    // 檢查快取
    const cached = routeCache.get(icao24);
    if (cached && (Date.now() - cached.timestamp < ROUTE_CACHE_TTL)) {
        return res.json(cached.data);
    }

    try {
        const now = Math.floor(Date.now() / 1000);
        const begin = now - 86400; // 過去 24 小時
        const url = `https://opensky-network.org/api/flights/aircraft?icao24=${icao24}&begin=${begin}&end=${now}`;

        console.log(`✈️ [ROUTE] Fetching route for ${icao24}...`);
        const headers = await getAuthHeaders();
        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            if (response.status === 429) {
                return res.json({ icao24, noData: true, reason: 'rate_limited' });
            }
            return res.json({ icao24, noData: true });
        }

        const flights = await response.json();

        if (!flights || flights.length === 0) {
            const noDataResult = { icao24, noData: true };
            routeCache.set(icao24, { data: noDataResult, timestamp: Date.now() });
            return res.json(noDataResult);
        }

        // 取最新一筆航班
        const latest = flights[flights.length - 1];
        const routeData = {
            icao24,
            callsign: (latest.callsign || '').trim(),
            departureAirport: latest.estDepartureAirport || null,
            arrivalAirport: latest.estArrivalAirport || null,
            firstSeen: latest.firstSeen,
            lastSeen: latest.lastSeen,
        };

        routeCache.set(icao24, { data: routeData, timestamp: Date.now() });
        console.log(`✈️ [ROUTE] ${icao24}: ${routeData.departureAirport} → ${routeData.arrivalAirport}`);
        res.json(routeData);

    } catch (error) {
        console.error(`❌ [ROUTE ERROR] ${icao24}: ${error.message}`);
        res.json({ icao24, noData: true, error: error.message });
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
    console.log(`║   📁 Serving: ./public                   ║`);
    console.log(`║   🔑 Auth: ${process.env.OPENSKY_USER ? 'Enabled' : 'Disabled (no credentials)'}             ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
});
