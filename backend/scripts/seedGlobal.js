const mongoose = require('mongoose');
const https = require('https');
require('dotenv').config();
const Airline = require('../models/Airline');
const Airport = require('../models/Airport');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat';

/**
 * 格式化 Logo 網址
 */
const getLogoUrl = (icao) => {
    if (!icao) return null;
    return `https://pics.avs.io/200/200/${icao.toUpperCase()}.png`;
};

/**
 * 使用 https 模組下載 JSON
 */
function downloadJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: { 'User-Agent': 'AEROSTRAT-Seeder/1.0' }
        }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return downloadJson(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                reject(new Error(`Failed to download: ${url} (Status: ${res.statusCode})`));
                return;
            }
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
                }
            });
        }).on('error', reject);
    });
}

async function seedAirlines() {
    console.log('📡 Downloading global airlines data...');
    try {
        // 使用 npow/airline-codes 庫
        const data = await downloadJson('https://raw.githubusercontent.com/npow/airline-codes/master/airlines.json');

        console.log(`🧹 Cleaning airline data (Total: ${data.length})...`);
        const cleaned = data
            .filter(a => a.icao && a.icao.trim().length === 3 && a.icao !== 'N/A' && a.icao !== '\\N')
            .map(a => ({
                icao: a.icao.trim().toUpperCase(),
                name: a.name,
                country: a.country,
                logo: getLogoUrl(a.icao)
            }));

        // 去重 (以 ICAO 為主)
        const uniqueAirlines = Array.from(new Map(cleaned.map(a => [a.icao, a])).values());

        console.log(`💾 Inserting ${uniqueAirlines.length} unique airlines into MongoDB...`);
        await Airline.deleteMany({});
        await Airline.insertMany(uniqueAirlines);
        console.log('✅ Airlines seeded successfully.');
        return uniqueAirlines.length;
    } catch (e) {
        console.error('❌ Airline seeding failed:', e.message);
        throw e;
    }
}

async function seedAirports() {
    console.log('📡 Downloading global airports data...');
    try {
        const data = await downloadJson('https://raw.githubusercontent.com/mwgg/Airports/master/airports.json');

        console.log('🧹 Cleaning airport data...');
        const cleaned = [];
        for (const icao in data) {
            const a = data[icao];
            if (!a.lat || !a.lon) continue;
            
            cleaned.push({
                icao: icao.toUpperCase(),
                iata: (a.iata && a.iata !== '\\N' && a.iata.trim().length === 3) ? a.iata.toUpperCase() : null,
                name: a.name,
                city: a.city,
                country: a.country,
                location: {
                    type: 'Point',
                    coordinates: [parseFloat(a.lon), parseFloat(a.lat)]
                }
            });
        }

        console.log(`💾 Inserting ${cleaned.length} airports into MongoDB (chunked)...`);
        await Airport.deleteMany({});
        
        const CHUNK_SIZE = 1000;
        for (let i = 0; i < cleaned.length; i += CHUNK_SIZE) {
            const chunk = cleaned.slice(i, i + CHUNK_SIZE);
            await Airport.insertMany(chunk);
            if (i % 5000 === 0) console.log(`   ... inserted ${i} airports`);
        }
        
        console.log(`✅ ${cleaned.length} airports seeded successfully.`);
        return cleaned.length;
    } catch (e) {
        console.error('❌ Airport seeding failed:', e.message);
        throw e;
    }
}

async function runSeeding() {
    try {
        console.log('🚀 Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        
        const airlineCount = await seedAirlines();
        const airportCount = await seedAirports();

        console.log('\n==========================================');
        console.log(`🏁 SEEDING COMPLETE!`);
        console.log(`✈️ Airlines: ${airlineCount}`);
        console.log(`🛫 Airports: ${airportCount}`);
        console.log('==========================================\n');

    } catch (error) {
        console.error('❌ SEEDING FAILED:', error.message);
    } finally {
        console.log('🔌 Disconnecting from MongoDB...');
        await mongoose.disconnect();
        console.log('👋 Process finished.');
    }
}

runSeeding();
