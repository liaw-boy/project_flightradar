'use strict';
/**
 * syncVrsRoutes.js — 更新 VRS standing-data 並重建 routes.db
 *
 * 同步來源: https://github.com/vradarserver/standing-data (每日更新, CC0)
 * 執行流程:
 *   1. git fetch --no-filter + merge (繞過 blob:none，確保取得實際檔案)
 *   2. 重建 SQLite routes.db (routes / airports / airlines / model_types)
 */
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const STANDING_DATA_DIR = path.join(__dirname, '../data/standing-data');
const ROUTES_DIR      = path.join(STANDING_DATA_DIR, 'routes/schema-01');
const AIRPORTS_DIR    = path.join(STANDING_DATA_DIR, 'airports/schema-01');
const AIRLINES_FILE   = path.join(STANDING_DATA_DIR, 'airlines/schema-01/airlines.csv');
const MODEL_TYPE_DIR  = path.join(STANDING_DATA_DIR, 'model-type/schema-01');
const DB_PATH = path.join(__dirname, '../data/routes.db');
const DB_TMP  = DB_PATH + '.tmp';

// ── helpers ──────────────────────────────────────────────────────────────────

function collectCsvFiles(dir) {
    const result = [];
    if (!fs.existsSync(dir)) return result;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) result.push(...collectCsvFiles(full));
        else if (entry.name.endsWith('.csv')) result.push(full);
    }
    return result;
}

function readCsv(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
        const vals = line.split(',');
        const obj = {};
        headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
        return obj;
    });
}

// ── main ──────────────────────────────────────────────────────────────────────

async function syncVrsRoutes(log = console.log) {
    log('[VRS] 開始更新 VRS standing-data...');

    if (!fs.existsSync(STANDING_DATA_DIR)) {
        log('[VRS] standing-data 目錄不存在');
        return { success: false, error: 'standing-data not found' };
    }

    // ── 1. git fetch --no-filter，繞過 blob:none 拿到實際內容 ──────────────
    try {
        execSync('git fetch --no-filter origin', { cwd: STANDING_DATA_DIR, encoding: 'utf8', stdio: 'pipe' });
        execSync('git merge --ff-only origin/main',  { cwd: STANDING_DATA_DIR, encoding: 'utf8', stdio: 'pipe' });
        log('[VRS] git 更新完成');
    } catch (e) {
        log(`[VRS] git 更新失敗（繼續使用現有資料）: ${e.message}`);
    }

    // ── 2. 重建 SQLite ─────────────────────────────────────────────────────
    log('[VRS] 重建 routes.db...');
    try {
        const db = new Database(DB_TMP);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');

        db.exec(`
            CREATE TABLE routes (
                callsign     TEXT PRIMARY KEY,
                airline_icao TEXT,
                flight_number TEXT,
                airports     TEXT
            );
            CREATE INDEX idx_routes_callsign ON routes(callsign);

            CREATE TABLE airports (
                code        TEXT PRIMARY KEY,
                name        TEXT,
                icao        TEXT,
                iata        TEXT,
                location    TEXT,
                country_iso TEXT,
                lat         REAL,
                lng         REAL,
                alt_ft      REAL
            );
            CREATE INDEX idx_airports_icao ON airports(icao);
            CREATE INDEX idx_airports_iata ON airports(iata);

            CREATE TABLE airlines (
                code  TEXT PRIMARY KEY,
                name  TEXT,
                icao  TEXT,
                iata  TEXT
            );
            CREATE INDEX idx_airlines_icao ON airlines(icao);

            CREATE TABLE model_types (
                icao         TEXT PRIMARY KEY,
                manufacturer TEXT,
                model        TEXT,
                engine_count INTEGER,
                engine_type  TEXT,
                wtc          TEXT,
                species      TEXT
            );
        `);

        // ── routes ──────────────────────────────────────────────────────────
        {
            const ins = db.prepare(
                'INSERT OR REPLACE INTO routes (callsign,airline_icao,flight_number,airports) VALUES (?,?,?,?)'
            );
            const tx = db.transaction(rows => { for (const r of rows) ins.run(r); });
            let total = 0;
            for (const file of collectCsvFiles(ROUTES_DIR)) {
                const rows = [];
                const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
                for (const line of lines.slice(1)) {
                    const p = line.split(',');
                    if (p.length < 5) continue;
                    const [callsign, , flightNumber, airlineIcao, airports] = p;
                    if (!callsign || !airports) continue;
                    rows.push([callsign.trim(), airlineIcao.trim(), flightNumber.trim(), airports.trim()]);
                }
                if (rows.length) { tx(rows); total += rows.length; }
            }
            log(`[VRS] routes: ${total.toLocaleString()} 筆`);
        }

        // ── airports ─────────────────────────────────────────────────────────
        {
            const ins = db.prepare(
                'INSERT OR REPLACE INTO airports (code,name,icao,iata,location,country_iso,lat,lng,alt_ft) VALUES (?,?,?,?,?,?,?,?,?)'
            );
            const tx = db.transaction(rows => { for (const r of rows) ins.run(r); });
            let total = 0;
            for (const file of collectCsvFiles(AIRPORTS_DIR)) {
                const rows = readCsv(file)
                    .filter(r => r.Code)
                    .map(r => [
                        r.Code, r.Name, r.ICAO, r.IATA, r.Location, r.CountryISO2,
                        parseFloat(r.Latitude) || null,
                        parseFloat(r.Longitude) || null,
                        parseFloat(r.AltitudeFeet) || null,
                    ]);
                if (rows.length) { tx(rows); total += rows.length; }
            }
            log(`[VRS] airports: ${total.toLocaleString()} 筆`);
        }

        // ── airlines ──────────────────────────────────────────────────────────
        {
            const ins = db.prepare(
                'INSERT OR REPLACE INTO airlines (code,name,icao,iata) VALUES (?,?,?,?)'
            );
            const tx = db.transaction(rows => { for (const r of rows) ins.run(r); });
            const rows = readCsv(AIRLINES_FILE)
                .filter(r => r.Code)
                .map(r => [r.Code, r.Name, r.ICAO, r.IATA]);
            if (rows.length) { tx(rows); log(`[VRS] airlines: ${rows.length.toLocaleString()} 筆`); }
        }

        // ── model_types ───────────────────────────────────────────────────────
        {
            const ins = db.prepare(
                'INSERT OR REPLACE INTO model_types (icao,manufacturer,model,engine_count,engine_type,wtc,species) VALUES (?,?,?,?,?,?,?)'
            );
            const tx = db.transaction(rows => { for (const r of rows) ins.run(r); });
            let total = 0;
            for (const file of collectCsvFiles(MODEL_TYPE_DIR)) {
                const rows = readCsv(file)
                    .filter(r => r.ICAO)
                    .map(r => [
                        r.ICAO, r.Manufacturer, r.Model,
                        parseInt(r.EngineCount) || null,
                        r.EngineType, r.WTC, r.Species,
                    ]);
                if (rows.length) { tx(rows); total += rows.length; }
            }
            log(`[VRS] model_types: ${total.toLocaleString()} 筆`);
        }

        db.close();
        fs.renameSync(DB_TMP, DB_PATH);
        log('[VRS] routes.db 重建完成');
        return { success: true };

    } catch (e) {
        if (fs.existsSync(DB_TMP)) fs.unlinkSync(DB_TMP);
        log(`[VRS] 重建失敗: ${e.message}`);
        return { success: false, error: e.message };
    }
}

module.exports = { syncVrsRoutes };

if (require.main === module) {
    syncVrsRoutes().then(r => {
        process.exit(r.success ? 0 : 1);
    });
}
