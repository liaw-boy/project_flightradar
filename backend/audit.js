const fs = require('fs');
const path = require('path');

console.log('\n==================================================');
console.log(' 🛡️ AEROSTRAT 系統完整性掃描器 (Integrity Scanner) 🛡️');
console.log('==================================================\n');

try {
    const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    let passed = 0;
    let failed = 0;

    const check = (name, regex, description) => {
        if (regex.test(serverCode)) {
            console.log(`✅ [PASS] ${name}`);
            passed++;
            return true;
        } else {
            console.log(`❌ [FAIL] ${name}`);
            console.log(`   👉 缺失或損壞: ${description}`);
            failed++;
            return false;
        }
    };

    console.log('--- 📦 第一階段：原有核心功能保衛戰 (Legacy Features) ---');
    check('ETag 機場快取變數', /_cachedAirportListETag/, '找不到 _cachedAirportListETag，快取機制可能被刪除。');
    check('304 快取優化邏輯', /req\.headers\['if-none-match'\]/, '找不到 if-none-match 判斷，伺服器可能每次都在重新傳送機場資料。');
    check('資料缺失日誌系統', /missingDataLog/, '找不到 missingDataLog，日誌追蹤功能可能遺失。');
    check('SPA 前端 Fallback', /res\.sendFile\(.*index\.html'\)/, '找不到 index.html 的回傳路由，重新整理網頁會 404。');

    console.log('\n--- 🚀 第二階段：重構進度驗證 (New Progress) ---');
    const has404 = check('API 404 絕對防火牆', /app\.use\('\/api\/\*'/, '找不到 /api/* 的 404 攔截器，前端可能收到 HTML 導致解析崩潰。');
    check('FlightSession 軌跡查詢', /TrackPoint\.find\(\{\s*sessionId/, '軌跡查詢退化！沒有使用 sessionId 來撈取資料，會導致跨洋軌跡斷裂。');
    check('軌跡陣列 7 參數格式', /pt\.onGround \? 1 : 0/, '軌跡陣列缺少 onGround 參數 (第 7 個元素)，前端判斷起降會報錯。');
    check('GIS MongoDB 查詢', /Airport\.find\(\{\},\s*\{.*icao:\s*1/, '機場 API 沒有使用 MongoDB 的 .find() 撈取資料。');

    console.log('\n--- ⚖️ 第三階段：路由防線順序掃描 (Middleware Order) ---');
    if (has404) {
        const apiIndex = serverCode.indexOf("app.use('/api/*'");
        const spaIndex = serverCode.indexOf("res.sendFile(path.join(__dirname, 'public-react', 'index.html'))");
        
        if (apiIndex !== -1 && spaIndex !== -1 && apiIndex < spaIndex) {
            console.log(`✅ [PASS] 路由順序正確 (404 防火牆在 SPA Fallback 之上)`);
            passed++;
        } else {
            console.log(`❌ [FAIL] 路由順序錯誤！`);
            console.log(`   👉 404 防火牆必須放在 SPA Fallback 的正上方，否則會誤殺正常 API。`);
            failed++;
        }
    } else {
         console.log(`⚠️ [SKIP] 缺乏 API 404 防火牆，跳過順序掃描。`);
    }

    console.log('\n==================================================');
    if (failed === 0) {
        console.log(`🏆 掃描完成！總計 ${passed} 項檢測全數通過！系統處於完美狀態，可立即佈署！`);
    } else {
        console.log(`🚨 掃描完成！發現 ${failed} 項致命缺失！請立即修復上述 [FAIL] 的項目。`);
    }
    console.log('==================================================\n');

} catch (err) {
    console.error('❌ 無法讀取 server.js，請確定您在正確的目錄底下執行此腳本。', err.message);
}
