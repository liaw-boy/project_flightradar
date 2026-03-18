const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Airport = require('./models/Airport');

// Database URI
const MONGODB_URI = 'mongodb://127.0.0.1:27017/aerostrat';

// Data Path
const AIRPORTS_JSON = path.join(__dirname, 'data', 'processed', 'airports_global.json');

async function seed() {
    console.log('🚀 [SEED] Starting airport data migration...');

    try {
        await mongoose.connect(MONGODB_URI);
        console.log('✅ [SEED] Connected to MongoDB.');

        if (!fs.existsSync(AIRPORTS_JSON)) {
            console.error(`❌ [SEED] Data file not found at: ${AIRPORTS_JSON}`);
            process.exit(1);
        }

        console.log('📡 [SEED] Reading JSON data (this may take a few seconds)...');
        const rawData = JSON.parse(fs.readFileSync(AIRPORTS_JSON, 'utf8'));
        
        // Convert object to unique list by ICAO (fallback to IATA if ICAO is null)
        const airportMap = new Map();
        
        Object.entries(rawData).forEach(([key, ap]) => {
            const id = ap.icao || ap.iata;
            if (!id) return;
            
            // If we already have this icao/iata, skip duplicates
            if (airportMap.has(id)) return;
            
            // Only ingest if we have coordinates
            if (typeof ap.lat !== 'number' || typeof ap.lng !== 'number') return;

            airportMap.set(id, {
                icao: ap.icao || key,
                iata: ap.iata || null,
                name: ap.name || 'Unknown',
                city: ap.city || 'Unknown',
                country: ap.country || 'Unknown',
                location: {
                    type: 'Point',
                    coordinates: [ap.lng, ap.lat] // [lng, lat] order is CRITICAL
                }
            });
        });

        const airportList = Array.from(airportMap.values());
        console.log(`📦 [SEED] Prepared ${airportList.length} unique airports for migration.`);

        let count = 0;
        const total = airportList.length;
        const BATCH_SIZE = 1000;

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = airportList.slice(i, i + BATCH_SIZE);
            
            // Batch upsert using bulkWrite for performance
            const ops = batch.map(ap => ({
                updateOne: {
                    filter: { icao: ap.icao },
                    update: { $set: ap },
                    upsert: true
                }
            }));

            await Airport.bulkWrite(ops);
            count += batch.length;
            
            if (count % 5000 === 0 || count === total) {
                console.log(`⏳ [SEED] Progress: ${count}/${total} airports migrated...`);
            }
        }

        console.log(`\n🏆 [SEED] Migration SUCCESS! Total airports in DB: ${count}`);

    } catch (err) {
        console.error('❌ [SEED] Critical Error:', err.message);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 [SEED] Disconnected from MongoDB.');
    }
}

seed();
