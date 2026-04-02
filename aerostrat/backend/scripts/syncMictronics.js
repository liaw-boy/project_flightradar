/**
 * syncMictronics.js — Mictronics Aircraft Database Sync
 *
 * Downloads two datasets from mictronics.de (weekly updated, ODbL license):
 *   1. aircraft_db   → ICAO24 hex → { registration, typecode, operator }  (~400k records)
 *   2. aircraft_types → ICAO typecode → { description, wtc }              (~1k records)
 *
 * Both are ZIP archives. aircraft_db contains one JSON file per 2-char hex prefix.
 *
 * Run modes:
 *   node scripts/syncMictronics.js           — skip if data already exists
 *   FORCE_RESYNC=true node scripts/syncMictronics.js — always re-download
 */

'use strict';

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const AdmZip   = require('adm-zip');
const mongoose = require('mongoose');
const Aircraft = require('../models/Aircraft');

const DB_URL  = 'https://www.mictronics.de/aircraft-database/aircraft_db.php';
const TYPE_URL = 'https://www.mictronics.de/aircraft-database/aircraft_types.php';

const TEMP_DB_ZIP   = path.join(__dirname, '../data/mictronics_db.zip');
const TEMP_TYPE_ZIP = path.join(__dirname, '../data/mictronics_types.zip');
const TYPE_CACHE    = path.join(__dirname, '../data/aircraft_types.json');

const BATCH_SIZE = 500;                    // smaller batches → lower per-write CPU spike
const BATCH_DELAY_MS = 150;               // pause between batches — keeps MongoDB CPU < ~40%
const MICTRONICS_SOURCE_TAG = 'mictronics'; // stored in Aircraft.source to track provenance

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Wake-turbulence class → icon_type ────────────────────────────────────────
// wtc: J=Super-Heavy(A380), H=Heavy(Wide), M=Medium(Narrow), L=Light
function wtcToIconType(wtc, typecode) {
    const tc = (typecode || '').toUpperCase();
    // Military override from typecode patterns
    const MILITARY_PREFIXES = ['F1','F2','F3','F4','F5','F6','F7','F8','F9','A10','B52','B1B','B2','C17','C130','KC1','KC3','KC4','KC7','U2'];
    if (MILITARY_PREFIXES.some(p => tc.startsWith(p))) return 'MILITARY';

    switch ((wtc || '').toUpperCase()) {
        case 'J': return 'HEAVY_JET';    // Super (A380, AN-225)
        case 'H': return 'HEAVY_JET';    // Heavy  (B777, B744, A333…)
        case 'M': return 'STANDARD_JET'; // Medium (B738, A320…)
        case 'L': return 'LIGHT_PROP';   // Light  (C172, SR22…)
        default:  return 'STANDARD_JET';
    }
}

// ── Download helper (follows redirects) ──────────────────────────────────────
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(dest);
        const req = proto.get(url, { timeout: 30000 }, res => {
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

// ── Parse a single aircraft_db JSON entry ────────────────────────────────────
// Mictronics aircraft_db value format:
//   { "r": "N1234", "t": "B738", "f": "A0", "d": "United Airlines", "desc": "Boeing 737-800" }
//   `d`    = airline / operator name
//   `desc` = human-readable aircraft model name (e.g. "Eurocopter EC145 C-2") — may be absent
//
// Mictronics aircraft_types format: { "B738": { "desc": "L2J", "wtc": "M" } }
//   aircraft_types `desc` = ICAO type classification code ("L2J" = Land,2engines,Jet) — NOT a model name
//   Only `wtc` is used from aircraft_types.
function parseDbEntry(hex, entry, typesMap) {
    const typecode = (entry.t || '').trim().toUpperCase() || null;
    const typeInfo = typecode && typesMap[typecode] ? typesMap[typecode] : null;
    const wtc      = typeInfo ? typeInfo.wtc : null;
    const iconType = wtcToIconType(wtc, typecode);
    const operator = (entry.d || '').trim() || null;
    // `desc` in the aircraft_db entry is the human-readable model name
    const modelDesc = (entry.desc || '').trim() || null;

    return {
        hex:          hex.toLowerCase(),
        icao24:       hex.toLowerCase(),
        registration: (entry.r || '').trim() || null,
        type_code:    typecode,
        typecode:     typecode,
        operator:     operator,
        airline:      operator,
        model:        modelDesc,
        icon_type:    iconType,
        source:       MICTRONICS_SOURCE_TAG,
        lastUpdated:  new Date()
    };
}

// ── Import aircraft_db ZIP into MongoDB ───────────────────────────────────────
async function importAircraftDb(zipPath, typesMap, logger) {
    logger(`[Mictronics] Extracting aircraft_db ZIP (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)...`);

    let zip;
    try {
        zip = new AdmZip(zipPath);
    } catch (err) {
        throw new Error(`Failed to open ZIP: ${err.message}`);
    }

    const entries = zip.getEntries().filter(e => !e.isDirectory && e.name.endsWith('.json'));
    logger(`[Mictronics] Found ${entries.length} JSON shards in ZIP`);

    let totalProcessed = 0;
    let totalUpdated   = 0;

    for (const entry of entries) {
        let shard;
        try {
            shard = JSON.parse(entry.getData().toString('utf8'));
        } catch (e) {
            logger(`[Mictronics] Skipping malformed shard ${entry.name}: ${e.message}`);
            continue;
        }

        // Mictronics dump1090-fa format: shard file "a0.json" contains keys that are
        // the last 4 hex chars. Prepend the 2-char filename prefix to build full ICAO24.
        // Some shards may use full 6-char keys directly — handle both.
        const shardPrefix = entry.name.replace(/\.json$/i, '').toLowerCase(); // e.g. "a0"

        const hexKeys = Object.keys(shard);
        let bulkOps = [];

        for (const rawKey of hexKeys) {
            const key = rawKey.toLowerCase();
            // Build full 6-char ICAO24 hex.
            // Rule: shardPrefix + key must equal exactly 6 valid hex chars.
            // Prefix length varies: 1-char ("a"), 2-char ("a0"), or 3-char ("406").
            let hex;
            const expectedKeyLen = 6 - shardPrefix.length;
            if (key.length === expectedKeyLen && /^[0-9a-f]+$/.test(key)) {
                hex = shardPrefix + key;      // normal case: concatenate prefix + suffix
            } else if (key.length === 6 && /^[0-9a-f]{6}$/.test(key)) {
                hex = key;                    // shard already stores full 6-char hex
            } else {
                continue;                     // skip malformed entries
            }

            const parsed = parseDbEntry(hex, shard[rawKey], typesMap);

            // Only set fields that are non-null to avoid overwriting richer data
            const setFields = {
                // icao24 must be in $set (not just $setOnInsert) so the required constraint
                // is satisfied on new inserts without triggering duplicate-key on updates.
                // Both hex and icao24 hold the same lowercase ICAO24 value.
                icao24: parsed.hex,
                hex:    parsed.hex,
                icon_type:   parsed.icon_type,
                source:      MICTRONICS_SOURCE_TAG,
                lastUpdated: parsed.lastUpdated,
            };
            if (parsed.registration) setFields.registration = parsed.registration;
            if (parsed.type_code)    setFields.type_code    = parsed.type_code;
            if (parsed.type_code)    setFields.typecode     = parsed.type_code;
            if (parsed.operator)     setFields.operator     = parsed.operator;
            if (parsed.operator)     setFields.airline      = parsed.operator;
            if (parsed.model)        setFields.model        = parsed.model;

            bulkOps.push({
                updateOne: {
                    filter: { icao24: parsed.hex },
                    update: { $set: setFields },
                    upsert: true
                }
            });

            if (bulkOps.length >= BATCH_SIZE) {
                const result = await Aircraft.bulkWrite(bulkOps, { ordered: false });
                totalUpdated   += (result.upsertedCount || 0) + (result.modifiedCount || 0);
                totalProcessed += bulkOps.length;
                logger(`[Mictronics] Progress: ${totalProcessed.toLocaleString()} queued | ${totalUpdated.toLocaleString()} written`);
                bulkOps = [];
                await sleep(BATCH_DELAY_MS); // throttle: give MongoDB CPU breathing room
            }
        }

        if (bulkOps.length > 0) {
            const result = await Aircraft.bulkWrite(bulkOps, { ordered: false });
            totalUpdated   += (result.upsertedCount || 0) + (result.modifiedCount || 0);
            totalProcessed += bulkOps.length;
            await sleep(BATCH_DELAY_MS);
        }
    }

    logger(`[Mictronics] Aircraft DB import complete: ${totalProcessed.toLocaleString()} queued, ${totalUpdated.toLocaleString()} written to DB`);
    return totalProcessed;
}

// ── Load aircraft_types (ZIP or plain JSON) ───────────────────────────────────
async function loadAircraftTypes(zipPath, logger) {
    // If cached JSON already exists, use it
    if (fs.existsSync(TYPE_CACHE)) {
        try {
            const cached = JSON.parse(fs.readFileSync(TYPE_CACHE, 'utf8'));
            if (Object.keys(cached).length > 0) {
                logger(`[Mictronics] Using cached aircraft_types.json (${Object.keys(cached).length} types)`);
                return cached;
            }
        } catch (_) { /* fall through */ }
    }

    logger(`[Mictronics] Extracting aircraft_types ZIP...`);
    let rawJson = null;

    try {
        const zip = new AdmZip(zipPath);
        const jsonEntry = zip.getEntries().find(e => !e.isDirectory && e.name.endsWith('.json'));
        if (jsonEntry) {
            rawJson = jsonEntry.getData().toString('utf8');
        }
    } catch (_) {
        // Not a ZIP — try reading directly as JSON
        try {
            rawJson = fs.readFileSync(zipPath, 'utf8');
        } catch (e) {
            logger(`[Mictronics] Could not read aircraft_types: ${e.message}`);
            return {};
        }
    }

    if (!rawJson) return {};

    try {
        const types = JSON.parse(rawJson);
        fs.writeFileSync(TYPE_CACHE, JSON.stringify(types), 'utf8');
        logger(`[Mictronics] aircraft_types loaded: ${Object.keys(types).length} entries, cached to disk`);
        return types;
    } catch (e) {
        logger(`[Mictronics] Failed to parse aircraft_types JSON: ${e.message}`);
        return {};
    }
}

// ── Check if Mictronics data already exists in DB ────────────────────────────
async function hasMictronicsData() {
    const count = await Aircraft.countDocuments({ source: MICTRONICS_SOURCE_TAG });
    return count > 10000; // at least 10k records means data was imported
}

// ── Main sync function (called from server.js) ────────────────────────────────
async function syncMictronics(logFn) {
    const logger = logFn || (msg => console.log(msg));

    const forceResync = process.env.FORCE_RESYNC === 'true';

    if (!forceResync && await hasMictronicsData()) {
        const count = await Aircraft.countDocuments({ source: MICTRONICS_SOURCE_TAG });
        logger(`[Mictronics] Already have ${count.toLocaleString()} records. Skipping sync. (Set FORCE_RESYNC=true to override)`);
        return { skipped: true, count };
    }

    logger('[Mictronics] Starting sync from mictronics.de...');
    const startTime = Date.now();

    // Step 1: Download aircraft_types first (small, needed to enrich aircraft_db)
    logger(`[Mictronics] Downloading aircraft_types (${TYPE_URL})...`);
    try {
        await downloadFile(TYPE_URL, TEMP_TYPE_ZIP);
        logger('[Mictronics] aircraft_types download complete');
    } catch (err) {
        logger(`[Mictronics] WARN: Failed to download aircraft_types: ${err.message}. Continuing without type enrichment.`);
    }

    const typesMap = await loadAircraftTypes(TEMP_TYPE_ZIP, logger);

    // Step 2: Download aircraft_db (large ~4.6MB ZIP)
    logger(`[Mictronics] Downloading aircraft_db (~4.6 MB) from ${DB_URL}...`);
    await downloadFile(DB_URL, TEMP_DB_ZIP);
    logger('[Mictronics] aircraft_db download complete');

    // Step 3: Import into MongoDB
    const total = await importAircraftDb(TEMP_DB_ZIP, typesMap, logger);

    // Step 4: Cleanup temp ZIPs (keep type cache)
    [TEMP_DB_ZIP, TEMP_TYPE_ZIP].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger(`[Mictronics] Sync complete in ${elapsed}s — ${total.toLocaleString()} aircraft indexed`);
    return { total, elapsed };
}

// ── Standalone execution ──────────────────────────────────────────────────────
if (require.main === module) {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat';
    mongoose.connect(MONGODB_URI)
        .then(() => syncMictronics(console.log))
        .then(result => { console.log('[Mictronics] Done:', result); process.exit(0); })
        .catch(err => { console.error('[Mictronics] Fatal:', err); process.exit(1); });
}

module.exports = { syncMictronics };
