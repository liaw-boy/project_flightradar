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
app.use(express.static(path.join(__dirname, 'public-react'))); // React build
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
let openskyAccessToken = null;
let openskyTokenExpiresAt = 0;

async function getAuthHeaders() {
    const clientId = process.env.OPENSKY_USER;
    const clientSecret = process.env.OPENSKY_PASS;

    if (!clientId || !clientSecret) return {};

    // 如果 Token 還有效（保留 60 秒緩衝），直接回傳
    if (openskyAccessToken && Date.now() < openskyTokenExpiresAt) {
        return { 'Authorization': `Bearer ${openskyAccessToken}` };
    }

    try {
        console.log(`🔑 [AUTH] Fetching new OAuth2 token...`);
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);

        const response = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });

        if (!response.ok) {
            const err = await response.text();
            console.error(`❌ [AUTH ERROR] Failed to get token: ${err}`);
            return {};
        }

        const data = await response.json();
        openskyAccessToken = data.access_token;
        openskyTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

        console.log(`✅ [AUTH] Token received. Expires in ${data.expires_in}s.`);
        return { 'Authorization': `Bearer ${openskyAccessToken}` };
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
        timestamp: new Date().toISOString()
    });
});

// 取得飛機狀態（代理 OpenSky /states/all）
app.get('/api/states', async (req, res) => {
    const { lamin, lomin, lamax, lomax } = req.query;

    // 驗證參數
    if (!lamin || !lomin || !lamax || !lomax) {
        return res.status(400).json({ error: 'Missing required bounds parameters: lamin, lomin, lamax, lomax' });
    }

    const cacheKey = `states_${parseFloat(lamin).toFixed(1)}_${parseFloat(lomin).toFixed(1)}_${parseFloat(lamax).toFixed(1)}_${parseFloat(lomax).toFixed(1)}`;

    // 檢查快取
    const cached = getCached(cacheKey);
    if (cached) {
        console.log(`✅ [CACHE HIT] ${cacheKey}`);
        return res.json(cached);
    }

    try {
        const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;

        console.log(`🌐 [API CALL] Fetching states from OpenSky...`);
        const headers = await getAuthHeaders();
        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ [API ERROR] Status ${response.status}: ${errorText.substring(0, 200)}`);

            if (response.status === 429) {
                return res.status(429).json({ error: 'Rate limited by OpenSky. Please wait and try again.' });
            }
            return res.status(response.status).json({ error: `OpenSky API error: ${response.status}` });
        }

        const data = await response.json();

        // 存入快取
        setCache(cacheKey, data);
        console.log(`📦 [CACHED] ${cacheKey} | States: ${data.states ? data.states.length : 0}`);

        res.json(data);
    } catch (error) {
        console.error(`❌ [FETCH ERROR] ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch flight data', detail: error.message });
    }
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
// SPA Fallback — 未匹配的路由指向 React 前端
// ==========================================
app.use((req, res) => {
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
