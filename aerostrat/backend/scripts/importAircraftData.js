const mongoose = require('mongoose');
const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const path = require('path');
const Aircraft = require('../models/Aircraft');

// [v12.0] Integrated Command: Node Database Ingestion Engine
// Command: node backend/scripts/importAircraftData.js

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018/aerostrat';
const CSV_PATH = path.join(__dirname, '../data/aircraft.csv.gz');

// ─── [v12.0] Intelligence Mapping Logic ──────────────────────────────────────
function calculateIcon(typeCode, model) {
    if (!typeCode) return 'STANDARD_JET';
    const tc = typeCode.toUpperCase();
    const md = (model || '').toUpperCase();

    // 1. Military (Tactical/Fighter/Transport)
    if (['F16', 'F15', 'F18', 'F22', 'F35', 'A10', 'C17', 'C130', 'KC10', 'KC135', 'B1', 'B2', 'B52', 'MIG', 'SU27'].some(p => tc.startsWith(p))) return 'MILITARY';
    if (md.includes('MILITARY') || md.includes('SQUADRON') || md.includes('AIR FORCE')) return 'MILITARY';

    // 2. Heavy/Jumbo Jets (Wide-body)
    if (['B74', 'A34', 'A35', 'A38', 'B77', 'B78', 'DC10', 'MD11', 'L101'].some(p => tc.startsWith(p))) return 'HEAVY_JET';
    if (md.includes('WIDEBODY') || md.includes('747') || md.includes('380')) return 'HEAVY_JET';

    // 3. Helicopters
    if (tc.startsWith('H') && tc.length <= 4) {
        if (['H60', 'H64', 'H47', 'H53', 'H135', 'H145', 'B06', 'B206', 'B212', 'B412', 'AS50', 'AS55'].some(p => tc.includes(p))) return 'HELICOPTER';
    }
    if (md.includes('HELICOPTER') || md.includes('ROTORCRAFT')) return 'HELICOPTER';

    // 4. Light Propeller / General Aviation
    if (['C172', 'C152', 'C182', 'P28A', 'SR20', 'SR22', 'BE20', 'BE9L', 'PC12', 'PC6', 'DHC6', 'C208'].some(p => tc.startsWith(p))) return 'LIGHT_PROP';
    if (md.includes('CESSNA') || md.includes('PIPER') || md.includes('BEECHCRAFT')) return 'LIGHT_PROP';

    // 5. Default Standard Jet (A320, B738, etc.)
    return 'STANDARD_JET';
}

async function runImport() {
    try {
        console.log('📡 [AERO-SYNC] Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ [AERO-SYNC] Connected.');

        const inputStream = fs.createReadStream(CSV_PATH);
        const gunzip = zlib.createGunzip();
        const lineReader = readline.createInterface({
            input: inputStream.pipe(gunzip),
            terminal: false
        });

        let bulkOps = [];
        let count = 0;
        let totalProcessed = 0;

        console.log('🚀 [AERO-SYNC] Starting High-Speed Data Ingestion...');

        for await (const line of lineReader) {
            // Format check: hex;reg;type;?;model;;;
            const parts = line.split(';');
            if (parts.length < 3) continue;

            const hex = parts[0].trim().toLowerCase();
            const reg = parts[1].trim();
            const type = parts[2].trim();
            const model = parts[4] ? parts[4].trim() : '';

            if (!hex) continue;

            bulkOps.push({
                updateOne: {
                    filter: { hex: hex },
                    update: {
                        $set: {
                            icao24: hex, // Ensure required field for legacy unique index
                            registration: reg,
                            type_code: type,
                            operator: '', // CSV doesn't have operator field, will be enriched later
                            icon_type: calculateIcon(type, model),
                            manufacturer: model.split(' ')[0],
                            lastUpdated: new Date()
                        }
                    },
                    upsert: true
                }
            });

            if (bulkOps.length >= 1000) {
                await Aircraft.bulkWrite(bulkOps);
                totalProcessed += bulkOps.length;
                console.log(`📦 [AERO-SYNC] Progress: ${totalProcessed} records indexed...`);
                bulkOps = [];
            }
        }

        if (bulkOps.length > 0) {
            await Aircraft.bulkWrite(bulkOps);
            totalProcessed += bulkOps.length;
        }

        console.log(`\n✅ [戰報] 飛機資料庫匯入完成！`);
        console.log(`🚩 總計處理: ${totalProcessed} 架飛機`);
        process.exit(0);
    } catch (err) {
        console.error('❌ [ERROR] Import failed:', err);
        process.exit(1);
    }
}

runImport();
