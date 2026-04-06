'use strict';
/**
 * syncMictronics.js — Mictronics Aircraft Database Weekly Sync
 *
 * Downloads two datasets from mictronics.de (weekly updated, ODbL license):
 *   1. aircraft_db   → ICAO24 hex → { r: registration, t: typecode, d: operator, desc: model }
 *   2. aircraft_types → ICAO typecode → { wtc }  (wake-turbulence class)
 *
 * Data is stored in the SQLite mictronics_aircraft table via mictronicsDb.bulkUpsert().
 *
 * Run modes:
 *   node scripts/syncMictronics.js              — skip if table already has data
 *   FORCE_RESYNC=true node scripts/syncMictronics.js — always re-download
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const AdmZip = require('adm-zip');

const DB_URL   = 'https://www.mictronics.de/aircraft-database/aircraft_db.php';
const TYPE_URL = 'https://www.mictronics.de/aircraft-database/aircraft_types.php';

const TEMP_DIR      = path.join(__dirname, '..', 'data');
const TEMP_DB_ZIP   = path.join(TEMP_DIR, 'mictronics_db.zip');
const TEMP_TYPE_ZIP = path.join(TEMP_DIR, 'mictronics_types.zip');
const TYPE_CACHE    = path.join(TEMP_DIR, 'aircraft_types.json');

const BATCH_SIZE = 2000;  // rows per SQLite transaction

// ── Download helper (follows redirects, 60s timeout) ─────────────────────────
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const file  = fs.createWriteStream(dest);
        const req   = proto.get(url, { timeout: 60000 }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                fs.unlink(dest, () => {});
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        });
        req.on('error', err => { file.close(); fs.unlink(dest, () => {}); reject(err); });
    });
}

// ── Load aircraft_types from ZIP or cached JSON ───────────────────────────────
function loadAircraftTypes(zipPath, logger) {
    if (fs.existsSync(TYPE_CACHE)) {
        try {
            const cached = JSON.parse(fs.readFileSync(TYPE_CACHE, 'utf8'));
            if (Object.keys(cached).length > 0) {
                logger(`[Mictronics] Using cached aircraft_types.json (${Object.keys(cached).length} types)`);
                return cached;
            }
        } catch (_) {}
    }

    try {
        const zip      = new AdmZip(zipPath);
        const jsonEntry = zip.getEntries().find(e => !e.isDirectory && e.name.endsWith('.json'));
        if (jsonEntry) {
            const types = JSON.parse(jsonEntry.getData().toString('utf8'));
            fs.writeFileSync(TYPE_CACHE, JSON.stringify(types), 'utf8');
            logger(`[Mictronics] aircraft_types loaded: ${Object.keys(types).length} entries`);
            return types;
        }
    } catch (e) {
        logger(`[Mictronics] WARN: could not load aircraft_types: ${e.message}`);
    }
    return {};
}

// ── Import ZIP into SQLite via mictronicsDb ───────────────────────────────────
function importAircraftDb(zipPath, typesMap, logger) {
    const MictronicsDb = require('../db/mictronicsDb');

    logger(`[Mictronics] Extracting ZIP (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)...`);

    let zip;
    try {
        zip = new AdmZip(zipPath);
    } catch (err) {
        throw new Error(`Failed to open ZIP: ${err.message}`);
    }

    const shards = zip.getEntries().filter(e => !e.isDirectory && e.name.endsWith('.json'));
    logger(`[Mictronics] ${shards.length} JSON shards found`);

    let totalRows = 0;
    let batch     = [];

    const flush = () => {
        if (batch.length === 0) return;
        MictronicsDb.bulkUpsert(batch);
        totalRows += batch.length;
        batch = [];
    };

    for (const entry of shards) {
        let shard;
        try {
            shard = JSON.parse(entry.getData().toString('utf8'));
        } catch (e) {
            logger(`[Mictronics] Skipping malformed shard ${entry.name}`);
            continue;
        }

        // Shard filename prefix: "a0.json" → prefix "a0"
        const shardPrefix  = entry.name.replace(/\.json$/i, '').toLowerCase();
        const expectedSufLen = 6 - shardPrefix.length;

        for (const [rawKey, val] of Object.entries(shard)) {
            const key = rawKey.toLowerCase();
            let icao24;

            if (key.length === expectedSufLen && /^[0-9a-f]+$/.test(key)) {
                icao24 = shardPrefix + key;
            } else if (key.length === 6 && /^[0-9a-f]{6}$/.test(key)) {
                icao24 = key;
            } else {
                continue;
            }

            const typecode   = (val.t || '').trim().toUpperCase() || null;
            const registration = (val.r || '').trim() || null;
            const operator   = (val.d || '').trim() || null;
            const model      = (val.desc || '').trim() || null;

            // Skip completely empty records
            if (!registration && !typecode && !operator && !model) continue;

            batch.push({ icao24, registration, typecode, operator, model });

            if (batch.length >= BATCH_SIZE) {
                flush();
                if (totalRows % 50000 === 0) {
                    logger(`[Mictronics] Progress: ${totalRows.toLocaleString()} rows written`);
                }
            }
        }
    }

    flush();
    logger(`[Mictronics] Import complete: ${totalRows.toLocaleString()} rows written to SQLite`);
    return totalRows;
}

// ── Main sync function ────────────────────────────────────────────────────────
async function syncMictronics(logFn) {
    const logger = logFn || (msg => console.log(msg));

    const forceResync = process.env.FORCE_RESYNC === 'true';

    if (!forceResync) {
        const MictronicsDb = require('../db/mictronicsDb');
        const existing = MictronicsDb.count();
        if (existing > 10000) {
            const lastSync = MictronicsDb.lastSyncTime();
            const ageHours = lastSync ? ((Date.now() / 1000 - lastSync) / 3600).toFixed(0) : 'unknown';
            logger(`[Mictronics] Already have ${existing.toLocaleString()} records (synced ${ageHours}h ago). Skipping. (FORCE_RESYNC=true to override)`);
            return { skipped: true, count: existing };
        }
    }

    logger('[Mictronics] Starting sync from mictronics.de...');
    const startTime = Date.now();

    // Step 1: Download aircraft_types (small, ~17KB)
    logger(`[Mictronics] Downloading aircraft_types...`);
    try {
        await downloadFile(TYPE_URL, TEMP_TYPE_ZIP);
    } catch (err) {
        logger(`[Mictronics] WARN: Failed to download aircraft_types: ${err.message}`);
    }
    const typesMap = loadAircraftTypes(TEMP_TYPE_ZIP, logger);

    // Step 2: Download aircraft_db (~4.6 MB ZIP)
    logger(`[Mictronics] Downloading aircraft_db (~4.6 MB)...`);
    await downloadFile(DB_URL, TEMP_DB_ZIP);
    logger('[Mictronics] Download complete');

    // Step 3: Import into SQLite
    const total = importAircraftDb(TEMP_DB_ZIP, typesMap, logger);

    // Step 4: Cleanup temp ZIPs
    for (const f of [TEMP_DB_ZIP, TEMP_TYPE_ZIP]) {
        try { fs.unlinkSync(f); } catch (_) {}
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger(`[Mictronics] ✅ Sync complete in ${elapsed}s — ${total.toLocaleString()} aircraft in DB`);
    return { total, elapsed };
}

// ── Standalone execution ──────────────────────────────────────────────────────
if (require.main === module) {
    syncMictronics(console.log)
        .then(r => { console.log('[Mictronics] Done:', r); process.exit(0); })
        .catch(e => { console.error('[Mictronics] Fatal:', e); process.exit(1); });
}

module.exports = { syncMictronics };
