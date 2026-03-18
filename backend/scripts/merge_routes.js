/**
 * merge_routes.js
 * 整合全球 15 萬條航線連通性，並建立航空公司前綴索引。
 */
const fs = require('fs');
const path = require('path');

const RAW_OPENFLIGHTS = path.join(__dirname, '../data/raw_openflights.dat');
const RAW_JONTY = path.join(__dirname, '../data/raw_jonty.json');
const OUTPUT_PATH = path.join(__dirname, '../data/processed/schedules_global.json');
const PREFIX_PATH = path.join(__dirname, '../data/processed/airline_prefixes.json');
const STATIC_PATH = path.join(__dirname, '../data/schedules_static.json');
const CACHE_PATH = path.join(__dirname, '../routes-cache.json');

async function mergeAll() {
    console.log("🚀 [ULTIMATE MERGE] 正在構建全球大數據引擎...");
    let callsignMap = {};
    let airlineNetwork = {};

    // 1. 載入最高優先權資料 (靜態定義與已學習快取)
    if (fs.existsSync(STATIC_PATH)) {
        console.log("📂 正在載入 schedules_static.json...");
        const data = JSON.parse(fs.readFileSync(STATIC_PATH, 'utf8'));
        Object.assign(callsignMap, data);
    }

    if (fs.existsSync(CACHE_PATH)) {
        console.log("📂 正在載入 routes-cache.json...");
        const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        Object.assign(callsignMap, data);
    }

    // 2. 解析 OpenFlights (6.7 萬筆航線)
    if (fs.existsSync(RAW_OPENFLIGHTS)) {
        console.log("📂 正在解析 OpenFlights 原始數據...");
        const lines = fs.readFileSync(RAW_OPENFLIGHTS, 'utf8').split('\n');
        lines.forEach(line => {
            const p = line.split(',');
            if (p.length >= 5) {
                const airline = p[0].replace(/"/g, '').trim();
                const dep = p[2].replace(/"/g, '').trim();
                const arr = p[4].replace(/"/g, '').trim();
                if (airline.length >= 2 && airline.length <= 3) {
                    if (!airlineNetwork[airline]) airlineNetwork[airline] = [];
                    // 避免重複
                    if (!airlineNetwork[airline].some(r => r.dep === dep && r.arr === arr)) {
                        airlineNetwork[airline].push({ dep, arr });
                    }
                }
            }
        });
    }

    // 3. 解析 Jonty (8.5 萬筆商業航線)
    if (fs.existsSync(RAW_JONTY)) {
        console.log("📂 正在解析 Jonty's Global JSON...");
        const jonty = JSON.parse(fs.readFileSync(RAW_JONTY, 'utf8'));
        for (const [depIata, info] of Object.entries(jonty)) {
            if (info.routes) {
                info.routes.forEach(r => {
                    const arrIata = r.iata;
                    if (r.carriers) {
                        r.carriers.forEach(c => {
                            const airline = c.iata;
                            if (airline) {
                                if (!airlineNetwork[airline]) airlineNetwork[airline] = [];
                                if (!airlineNetwork[airline].some(rout => rout.dep === (info.iata || depIata) && rout.arr === arrIata)) {
                                    airlineNetwork[airline].push({ dep: info.iata || depIata, arr: arrIata });
                                }
                            }
                        });
                    }
                });
            }
        }
    }

    // 儲存結果 (使用 UTF-8 並確保不亂碼)
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(callsignMap, null, 2), 'utf8');
    fs.writeFileSync(PREFIX_PATH, JSON.stringify(airlineNetwork, null, 2), 'utf8');

    console.log("-----------------------------------------");
    console.log("✨ [COMPLETE] 數據引擎準備就緒！");
    console.log(`📊 精確呼號對應: ${Object.keys(callsignMap).length} 筆`);
    console.log(`🌍 航空公司網絡: ${Object.keys(airlineNetwork).length} 家航空公司 (航線總數顯著提升)`);
}

mergeAll().catch(console.error);
