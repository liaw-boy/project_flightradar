/**
 * seedAircraftShapes.js
 *
 * 從 RexKramer1/AircraftShapesSVG (GPLv3) 下載全部飛機 SVG，
 * 解析後批次寫入 MongoDB AircraftShape collection。
 *
 * 使用方式 (在 backend/ 目錄執行):
 *   npm run seed-shapes
 *
 * 注意: 需要 MongoDB 正在運行且 .env 設定正確。
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const AircraftShape = require('../models/AircraftShape');

const GITHUB_API  = 'https://api.github.com/repos/RexKramer1/AircraftShapesSVG/git/trees/main?recursive=1';
const RAW_BASE    = 'https://raw.githubusercontent.com/RexKramer1/AircraftShapesSVG/main/Shapes%20SVG/';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat';

// ── SVG 解析 ──────────────────────────────────────────────────────────────────

function extractViewBox(svgText) {
    const m = svgText.match(/viewBox="([^"]+)"/);
    return m ? m[1] : '0 0 80 80';
}

function extractPaths(svgText) {
    const paths = [];
    const re = /<path[^>]*\sd="([^"]+)"/g;
    let m;
    while ((m = re.exec(svgText)) !== null) {
        const d = m[1].trim();
        if (d.length > 10) paths.push(d);
    }
    return paths;
}

function filenameToTypecode(filename) {
    // "A320.svg" → "A320", "B1 fast.svg" → "B1_FAST"
    return filename
        .replace(/\.svg$/i, '')
        .trim()
        .replace(/\s+/g, '_')
        .toUpperCase();
}

// ── 帶重試的 Fetch ─────────────────────────────────────────────────────────────

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'AEROSTRAT-SeedScript/1.0' }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n✈  AEROSTRAT Aircraft Shape Seeder');
    console.log('   Source: github.com/RexKramer1/AircraftShapesSVG (GPLv3)\n');

    // 1. 連線 MongoDB
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('🍃 Connected to MongoDB\n');

    // 2. 取得 SVG 檔案清單
    console.log('📡 Fetching file tree from GitHub API...');
    const treeRes = await fetchWithRetry(GITHUB_API);
    const treeData = await treeRes.json();

    if (!treeData.tree) throw new Error('GitHub API missing tree: ' + JSON.stringify(treeData));

    const files = treeData.tree
        .filter(item => item.type === 'blob' && item.path.startsWith('Shapes SVG/') && item.path.endsWith('.svg'))
        .map(item => item.path.replace('Shapes SVG/', ''));

    console.log(`   Found ${files.length} SVG files.\n`);

    // 3. 逐一下載、解析、收集
    const shapes = [];
    let ok = 0, fail = 0;

    for (let i = 0; i < files.length; i++) {
        const filename = files[i];
        const typecode = filenameToTypecode(filename);
        process.stdout.write(`[${String(i + 1).padStart(3)}/${files.length}] ${typecode.padEnd(14)}`);

        try {
            const url = RAW_BASE + encodeURIComponent(filename);
            const svgText = await (await fetchWithRetry(url)).text();

            const viewBox = extractViewBox(svgText);
            const paths   = extractPaths(svgText);

            if (paths.length === 0) {
                process.stdout.write(' ⚠  no paths\n');
                fail++;
                continue;
            }

            shapes.push({ typecode, viewBox, paths });
            process.stdout.write(` ✓  (${paths.length} paths)\n`);
            ok++;
        } catch (err) {
            process.stdout.write(` ✗  ${err.message}\n`);
            fail++;
        }

        // 避免請求過快
        await new Promise(r => setTimeout(r, 50));
    }

    // 4. 批次寫入 MongoDB (upsert)
    console.log(`\n💾 Writing ${shapes.length} shapes to MongoDB...`);

    const ops = shapes.map(s => ({
        updateOne: {
            filter: { typecode: s.typecode },
            update: { $set: s },
            upsert: true
        }
    }));

    const result = await AircraftShape.bulkWrite(ops, { ordered: false });
    console.log(`   Upserted: ${result.upsertedCount}, Modified: ${result.modifiedCount}`);
    console.log(`\n✅ Done: ${ok} shapes written, ${fail} failed.\n`);

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    mongoose.disconnect();
    process.exit(1);
});
