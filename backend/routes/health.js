'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Shared with the startup catch-up checks in server.js — a single definition
// so the freshness badge and the "should I resync on boot" decision can't drift.
const DATA_FRESHNESS_THRESHOLDS = {
    mictronics: 9 * 24 * 3600 * 1000,   // 9 days (weekly job)
    vrs:        2 * 24 * 3600 * 1000,   // 2 days (daily job)
    tdx:        25 * 3600 * 1000,        // 25 hours (daily at 4am)
    metar:      2 * 3600 * 1000,        // 2 hours (runs every 1 hour)
};

// deps: pieces of server.js's module-level state this route group reads.
// getGlobalPlanesCache/getCpuUsage are accessors (not direct references)
// because those two are reassigned (`let x = {...}`) elsewhere in
// server.js — a captured reference would go stale after the first
// reassignment, unlike the Maps/objects below which are only ever
// mutated in place.
// Constant-time compare against METRICS_TOKEN, same pattern as
// isMonitorPasswordValid in middleware/monitorAuth.js.
function isMetricsTokenValid(token) {
    const expected = process.env.METRICS_TOKEN;
    if (!expected || typeof token !== 'string') return false;
    const expectedBuf = Buffer.from(expected);
    const givenBuf = Buffer.from(token);
    if (givenBuf.length !== expectedBuf.length) {
        crypto.timingSafeEqual(expectedBuf, Buffer.alloc(expectedBuf.length));
        return false;
    }
    return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

// The process binds to 0.0.0.0 (see server.listen in server.js), so this
// isn't just a formality — without it, anything reachable on the LAN could
// try the token. Loopback-only + token is defense in depth, matching how
// /monitor is session+password gated rather than password-only.
function isLoopback(req) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function registerHealthRoutes(app, deps) {
    const {
        requireAdminAccess, syncLog, activeSessions,
        ingestionStats, sourceHealth, apiStats, TrackPoint, FlightSession,
        getMasterStateMap, getGlobalPlanesCache, getCpuUsage, backendDir,
        getClientCount,
    } = deps;

    app.get('/api/ping', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

    // Data freshness — public, used by frontend to show persistent stale badges.
    // A job is "stale" if it has never succeeded, or last success was >THRESHOLD ago
    app.get('/api/data-freshness', (req, res) => {
        const all  = syncLog.getAll();
        const now  = Date.now();
        const jobs = {};
        let   anyStale = false;

        for (const [job, threshold] of Object.entries(DATA_FRESHNESS_THRESHOLDS)) {
            const entry   = all[job] || {};
            const lastOk  = entry.lastSuccess ? new Date(entry.lastSuccess).getTime() : null;
            const ageMs   = lastOk ? now - lastOk : null;
            const stale   = ageMs === null || ageMs > threshold;
            if (stale) anyStale = true;
            jobs[job] = {
                stale,
                lastSuccess: entry.lastSuccess || null,
                ageDays:     ageMs !== null ? Math.floor(ageMs / 86400000) : null,
                error:       entry.error || null,
                consecutiveFails: entry.consecutiveFails || 0,
            };
        }

        res.json({ anyStale, jobs });
    });

    app.get('/api/health', requireAdminAccess, (req, res) => {
        const dbPath = path.join(backendDir, 'data', 'aerostrat.db');
        let dbSize = 0;
        try { if (fs.existsSync(dbPath)) dbSize = fs.statSync(dbPath).size; } catch (_) {}

        // [v12.8] Extended Hardware Stats
        const cpus = os.cpus();
        const cpuModel = cpus.length > 0 ? cpus[0].model.replace(/\s+/g, ' ') : 'Unknown';
        const cpuCores = cpus.length;

        let diskUsage = { total: 0, free: 0, used: 0 };
        try {
            const stats = fs.statfsSync('/');
            diskUsage.total = Number(stats.bsize) * Number(stats.blocks);
            diskUsage.free = Number(stats.bsize) * Number(stats.bfree);
            diskUsage.used = diskUsage.total - diskUsage.free;
        } catch (_) {}

        const masterStateMap = getMasterStateMap();
        const globalPlanesCache = getGlobalPlanesCache();

        res.json({
            status: 'ok',
            uptime: process.uptime(),
            cacheSize: masterStateMap?.size ?? globalPlanesCache.states?.length ?? 0,
            activeSessions: activeSessions.size,
            ingestion: ingestionStats,
            performance: {
                process: {
                    memory: process.memoryUsage(),
                    cpu: process.cpuUsage()
                },
                system: {
                    load: os.loadavg(),
                    cpuUsage: getCpuUsage(),
                    freeMem: os.freemem(),
                    totalMem: os.totalmem(),
                    cpuModel,
                    cpuCores,
                    arch: os.arch(),
                    platform: os.platform(),
                    disk: diskUsage
                }
            },
            storage: {
                dbSize,
                dbPath: 'backend/data/aerostrat.db'
            },
            timestamp: new Date().toISOString()
        });
    });

    // Local-only metrics for the host's Zabbix agent (UserParameter script)
    // to scrape. Deliberately separate from /api/health's MONITOR_PASSWORD
    // session auth — a system-level polling script shouldn't need the human
    // admin password, so it gets its own token (METRICS_TOKEN) instead.
    app.get('/internal/metrics', (req, res) => {
        if (!isLoopback(req) || !isMetricsTokenValid(req.get('x-metrics-token'))) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const masterStateMap = getMasterStateMap();
        const globalPlanesCache = getGlobalPlanesCache();
        const freshness = syncLog.getAll();
        const staleJobs = Object.entries(DATA_FRESHNESS_THRESHOLDS)
            .filter(([job, threshold]) => {
                const entry = freshness[job] || {};
                const lastOk = entry.lastSuccess ? new Date(entry.lastSuccess).getTime() : null;
                return lastOk === null || (Date.now() - lastOk) > threshold;
            })
            .map(([job]) => job);
        const mem = process.memoryUsage();

        res.json({
            timestamp: new Date().toISOString(),
            uptime_s: Math.round(process.uptime()),
            memory_rss_mb: Math.round(mem.rss / 1024 / 1024),
            memory_heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
            planes_tracked: masterStateMap?.size ?? globalPlanesCache.states?.length ?? 0,
            active_sessions: activeSessions.size,
            ws_clients: getClientCount ? getClientCount() : null,
            data_freshness_stale_jobs: staleJobs,
            api_errors_total: apiStats.errors,
            api_last_error_time: apiStats.lastErrorTime || null,
            source_health: sourceHealth,
        });
    });

    app.get('/api/ingestion/status', requireAdminAccess, async (req, res) => {
        let trackPointCount = null;
        let sessionCount = null;
        try {
            trackPointCount = await TrackPoint.estimatedDocumentCount();
            sessionCount = await FlightSession.estimatedDocumentCount();
        } catch (_) { }
        const globalPlanesCache = getGlobalPlanesCache();
        res.json({
            ...ingestionStats,
            activeSessions: activeSessions.size,
            trackPointsInDB: trackPointCount,
            activeSessionsInDB: sessionCount,
            globalCachePlanes: globalPlanesCache.states?.length || 0,
            globalCacheStale: globalPlanesCache.stale || false
        });
    });

    app.get('/api/stats', requireAdminAccess, function (req, res) {
        const masterStateMap = getMasterStateMap();
        const globalPlanesCache = getGlobalPlanesCache();
        res.json({
            totalCalls: apiStats.totalCalls,
            stateCalls: apiStats.stateCalls,
            metadataCalls: apiStats.metadataCalls,
            cacheHits: apiStats.cacheHits,
            errors: apiStats.errors,
            lastError: apiStats.lastError,
            lastErrorTime: apiStats.lastErrorTime,
            lastSuccessTime: apiStats.lastSuccessTime,
            uptimeMinutes: Math.round((Date.now() - apiStats.startTime) / 60000),
            // [v11.0] Per-source health for DevPanel
            sourceHealth,
            totalPlanes: masterStateMap?.size ?? globalPlanesCache.states?.length ?? 0,
        });
    });
}

module.exports = { registerHealthRoutes, DATA_FRESHNESS_THRESHOLDS };
