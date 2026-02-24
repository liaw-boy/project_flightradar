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
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 快取系統
// ==========================================
const cache = new Map();
const CACHE_TTL = 15000; // 15 秒快取

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
// OpenSky API 認證 Header
// ==========================================
function getAuthHeaders() {
    const user = process.env.OPENSKY_USER;
    const pass = process.env.OPENSKY_PASS;

    if (user && pass) {
        const credentials = Buffer.from(`${user}:${pass}`).toString('base64');
        return { 'Authorization': `Basic ${credentials}` };
    }
    return {};
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
        const response = await fetch(url, {
            headers: getAuthHeaders(),
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
        const response = await fetch(url, {
            headers: getAuthHeaders(),
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
// SPA Fallback — 所有未匹配路由指向前端
// ==========================================
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
