const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const Aircraft = require('./models/Aircraft');
const Metar = require('./models/Metar');

// 配置路徑
const AIRCRAFT_CACHE = path.join(__dirname, 'aircraft-cache.json');
const METAR_CACHE = path.join(__dirname, 'metar-cache.json');

async function migrate() {
    console.log('🚀 [MIGRATION] Starting JSON to MongoDB migration...');

    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat');
        console.log('✅ [DB] Connected for migration');

        // 1. 遷移 Aircraft
        if (fs.existsSync(AIRCRAFT_CACHE)) {
            const aircraftData = JSON.parse(fs.readFileSync(AIRCRAFT_CACHE, 'utf8'));
            const aircraftOps = Object.keys(aircraftData).map(icao24 => {
                const data = aircraftData[icao24];
                return {
                    updateOne: {
                        filter: { icao24: icao24.toLowerCase() },
                        update: {
                            $set: {
                                icao24: icao24.toLowerCase(),
                                registration: data.registration || '',
                                manufacturerName: data.manufacturerName || '',
                                model: data.model || '',
                                typecode: data.typecode || '',
                                owner: data.owner || '',
                                operatorCallsign: data.operatorCallsign || '',
                                lastUpdated: new Date()
                            }
                        },
                        upsert: true
                    }
                };
            });

            if (aircraftOps.length > 0) {
                const res = await Aircraft.bulkWrite(aircraftOps, { ordered: false });
                console.log(`✈️ [AIRCRAFT] Migrated ${res.upsertedCount + res.modifiedCount} records.`);
            }
        } else {
            console.warn('⚠️ [AIRCRAFT] Cache file not found, skipping...');
        }

        // 2. 遷移 Metar
        if (fs.existsSync(METAR_CACHE)) {
            const metarData = JSON.parse(fs.readFileSync(METAR_CACHE, 'utf8'));
            const metarOps = Object.keys(metarData).map(icaoId => {
                const data = metarData[icaoId];
                
                // GeoJSON format: [lng, lat]
                const lng = parseFloat(data.lon);
                const lat = parseFloat(data.lat);
                
                // Convert timestamp to Date object
                const obsDate = data.obsTime ? new Date(data.obsTime * 1000) : null;

                return {
                    updateOne: {
                        filter: { icaoId: icaoId.toUpperCase() },
                        update: {
                            $set: {
                                icaoId: icaoId.toUpperCase(),
                                iataId: data.iataId || '',
                                name: data.name || '',
                                lat: lat,
                                lon: lng,
                                location: {
                                    type: 'Point',
                                    coordinates: [lng, lat]
                                },
                                temp: data.temp || '',
                                dewp: data.dewp || '',
                                rawOb: data.rawOb || '',
                                obsTime: obsDate,
                                lastUpdated: new Date()
                            }
                        },
                        upsert: true
                    }
                };
            });

            if (metarOps.length > 0) {
                const res = await Metar.bulkWrite(metarOps, { ordered: false });
                console.log(`🌤️ [METAR] Migrated ${res.upsertedCount + res.modifiedCount} records (GeoJSON enabled).`);
            }
        } else {
            console.warn('⚠️ [METAR] Cache file not found, skipping...');
        }

        console.log('🏁 [MIGRATION] All tasks completed successfully.');
        process.exit(0);
    } catch (error) {
        console.error('❌ [MIGRATION FAILED]:', error);
        process.exit(1);
    }
}

migrate();
