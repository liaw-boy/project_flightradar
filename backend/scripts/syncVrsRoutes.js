'use strict';
/**
 * syncVrsRoutes.js — 更新 VRS standing-data 並重建 routes.db
 *
 * 執行流程：
 * 1. git pull (更新 standing-data)
 * 2. 重建 SQLite routes.db
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const STANDING_DATA_DIR = path.join(__dirname, '../data/standing-data');
const ROUTES_DIR = path.join(STANDING_DATA_DIR, 'routes/schema-01');
const DB_PATH = path.join(__dirname, '../data/routes.db');
const DB_TMP = DB_PATH + '.tmp';

async function syncVrsRoutes(log = console.log) {
    log('[VRS] 開始更新 VRS standing-data...');

    // 1. git pull
    if (!fs.existsSync(STANDING_DATA_DIR)) {
        log('[VRS] standing-data 目錄不存在，請先執行 build-routes-db.js');
        return { success: false, error: 'standing-data not found' };
    }

    try {
        const result = execSync('git pull', { cwd: STANDING_DATA_DIR, encoding: 'utf8' });
        log(`[VRS] git pull: ${result.trim()}`);
    } catch (e) {
        log(`[VRS] git pull 失敗: ${e.message}`);
        return { success: false, error: e.message };
    }

    // 2. 重建 SQLite（先寫到暫存檔，完成後再替換）
    log('[VRS] 重建 routes.db...');
    try {
        const db = new Database(DB_TMP);
        db.exec(`
            CREATE TABLE routes (
                callsign TEXT PRIMARY KEY,
                airline_icao TEXT,
                flight_number TEXT,
                airports TEXT
            );
            CREATE INDEX idx_callsign ON routes(callsign);
        `);

        const insert = db.prepare(
            'INSERT OR REPLACE INTO routes (callsign, airline_icao, flight_number, airports) VALUES (?, ?, ?, ?)'
        );
        const insertMany = db.transaction((rows) => {
            for (const row of rows) insert.run(row);
        });

        let total = 0;
        const csvFiles = [];

        function collectCsvFiles(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) collectCsvFiles(fullPath);
                else if (entry.name.endsWith('.csv')) csvFiles.push(fullPath);
            }
        }

        collectCsvFiles(ROUTES_DIR);

        for (const file of csvFiles) {
            const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
            const rows = [];
            for (const line of lines.slice(1)) {
                const parts = line.split(',');
                if (parts.length < 5) continue;
                const [callsign, , flightNumber, airlineIcao, airports] = parts;
                if (!callsign || !airports) continue;
                rows.push([callsign.trim(), airlineIcao.trim(), flightNumber.trim(), airports.trim()]);
            }
            if (rows.length > 0) {
                insertMany(rows);
                total += rows.length;
            }
        }

        db.close();

        // 原子替換
        fs.renameSync(DB_TMP, DB_PATH);
        log(`[VRS] 完成：共寫入 ${total} 筆航線資料`);
        return { success: true, total };

    } catch (e) {
        if (fs.existsSync(DB_TMP)) fs.unlinkSync(DB_TMP);
        log(`[VRS] 重建失敗: ${e.message}`);
        return { success: false, error: e.message };
    }
}

module.exports = { syncVrsRoutes };

// 直接執行
if (require.main === module) {
    syncVrsRoutes().then(r => {
        console.log('結果:', r);
        process.exit(r.success ? 0 : 1);
    });
}
