'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

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
function registerHealthRoutes(app, deps) {
    const {
        requireAdminAccess, syncLog, accountPool, rawAccounts, activeSessions,
        ingestionStats, sourceHealth, apiStats, TrackPoint, FlightSession,
        getMasterStateMap, getGlobalPlanesCache, getCpuUsage, backendDir,
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
            activeAccount: accountPool.getCurrentUser(),
            totalAccounts: rawAccounts.length,
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
            accounts: accountPool.getStats(),
            errors: apiStats.errors,
            lastError: apiStats.lastError,
            lastErrorTime: apiStats.lastErrorTime,
            lastSuccessTime: apiStats.lastSuccessTime,
            uptimeMinutes: Math.round((Date.now() - apiStats.startTime) / 60000),
            recommendedInterval: Math.round(accountPool.getRecommendedInterval(15000) / 1000),
            activeAccount: accountPool.getCurrentUser(),
            // [v11.0] Per-source health for DevPanel
            sourceHealth,
            totalPlanes: masterStateMap?.size ?? globalPlanesCache.states?.length ?? 0,
        });
    });
}

module.exports = { registerHealthRoutes, DATA_FRESHNESS_THRESHOLDS };
