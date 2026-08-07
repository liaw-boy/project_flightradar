'use strict';
/**
 * syncMictronics.js — Aircraft Registry Sync
 *
 * Source: wiedehopf/tar1090-db (GitHub), `aircraft.csv.gz` on the `csv` branch.
 * This replaced the original mictronics.de direct download — that endpoint
 * (aircraft-database/aircraft_db.php) returned 404 as of 2026-08, having
 * silently stopped working around 2026-06, two full months before anyone
 * noticed because the sync cron never logged the download failure anywhere
 * visible. tar1090-db is the community-maintained mirror/superset of the
 * same Mictronics data that readsb/tar1090 ship with their releases, kept
 * current by an active maintainer (wiedehopf), and — unlike the original
 * source — it also carries an operator field (`ownop`), which the old
 * mictronics_aircraft.operator column never had real data for.
 *
 * CSV row shape (semicolon-delimited, see tar1090-db's toJson.py writer):
 *   icao24;registration;typecode;flags;description;year;operator;<trailing empty>
 *
 * Data is stored in the SQLite mictronics_aircraft table via mictronicsDb.bulkUpsert().
 *
 * Run modes:
 *   node scripts/syncMictronics.js              — skip if table already has data
 *   FORCE_RESYNC=true node scripts/syncMictronics.js — always re-download
 */

const https = require('https');
const zlib  = require('zlib');

const CSV_GZ_URL = 'https://raw.githubusercontent.com/wiedehopf/tar1090-db/refs/heads/csv/aircraft.csv.gz';

const BATCH_SIZE = 2000;  // rows per SQLite transaction

// ── Download helper (follows redirects, buffers into memory, 60s timeout) ───
function downloadBuffer(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        https.get(url, { timeout: 60000 }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
                return downloadBuffer(res.headers.location, redirectsLeft - 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject).on('timeout', function () { this.destroy(new Error('Download timeout')); });
    });
}

// ── Parse the CSV and import into SQLite ─────────────────────────────────────
function importCsv(csvText, logger) {
    const MictronicsDb = require('../db/mictronicsDb');

    let totalRows = 0;
    let skipped = 0;
    let batch = [];

    const flush = () => {
        if (batch.length === 0) return;
        MictronicsDb.bulkUpsert(batch);
        totalRows += batch.length;
        batch = [];
    };

    const lines = csvText.split('\n');
    for (const line of lines) {
        if (!line) continue;
        const cols = line.split(';');
        const icao24 = (cols[0] || '').toLowerCase().trim();
        if (!/^[0-9a-f]{6}$/.test(icao24)) { skipped++; continue; }

        const registration = (cols[1] || '').trim() || null;
        const typecode      = (cols[2] || '').trim().toUpperCase() || null;
        // cols[3] is the flags bitfield (military/LADD/PIA) — not stored here.
        const model      = (cols[4] || '').trim() || null;
        // cols[5] is year — not currently in the mictronics_aircraft schema.
        const operator    = (cols[6] || '').trim() || null;

        if (!registration && !typecode && !operator && !model) { skipped++; continue; }

        batch.push({ icao24, registration, typecode, operator, model });

        if (batch.length >= BATCH_SIZE) {
            flush();
            if (totalRows % 100000 === 0) {
                logger(`[Mictronics] Progress: ${totalRows.toLocaleString()} rows written`);
            }
        }
    }

    flush();
    logger(`[Mictronics] Import complete: ${totalRows.toLocaleString()} rows written (${skipped.toLocaleString()} skipped)`);
    return totalRows;
}

// ── Main sync function ────────────────────────────────────────────────────────
// opts.force = true → skip existing-data check
async function syncMictronics(logFn, opts = {}) {
    const logger = logFn || (msg => console.log(msg));

    const forceResync = opts.force === true || process.env.FORCE_RESYNC === 'true';

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

    logger('[Mictronics] Starting sync from tar1090-db (GitHub)...');
    const startTime = Date.now();

    logger('[Mictronics] Downloading aircraft.csv.gz (~8-9 MB)...');
    const gzBuf = await downloadBuffer(CSV_GZ_URL);
    const csvText = zlib.gunzipSync(gzBuf).toString('utf8');
    logger(`[Mictronics] Download complete (${(gzBuf.length / 1024 / 1024).toFixed(1)} MB compressed)`);

    const total = importCsv(csvText, logger);

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
