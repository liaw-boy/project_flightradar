const fs = require('fs');
const path = require('path');
const https = require('https');
const csv = require('csv-parser');
const AirportDictionary = require('../models/AirportDictionary');
const RouteDictionary = require('../models/RouteDictionary');

const AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const ROUTES_URL = 'https://vrs-standing-data.adsb.lol/routes.csv';

const TEMP_AIRPORTS_CSV = path.join(__dirname, '..', 'temp_airports.csv');
const TEMP_ROUTES_CSV = path.join(__dirname, '..', 'temp_routes.csv');

async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const request = https.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to GET '${url}' (${response.statusCode})`));
            }
            response.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
        
        request.on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

async function syncAirports() {
    const count = await AirportDictionary.countDocuments();
    if (count > 0) {
        console.log(`[OSINT] AirportDictionary already has ${count} records. Skipping sync.`);
        return;
    }
    console.log(`[OSINT] Downloading airports data from ${AIRPORTS_URL}...`);
    await downloadFile(AIRPORTS_URL, TEMP_AIRPORTS_CSV);
    console.log(`[OSINT] Finished downloading airports. Parsing and inserting...`);

    return new Promise((resolve, reject) => {
        let batch = [];
        const BATCH_SIZE = 5000;
        let totalInserted = 0;

        const processBatch = async (isFinal = false) => {
            if (batch.length === 0) return;
            const ops = batch.map(row => {
                if (row.type === 'closed') return null;
                return {
                    insertOne: {
                        document: {
                            iata: row.iata_code || null,
                            icao: row.ident || null,
                            name: row.name || '',
                            city: row.municipality || '',
                            country: row.iso_country || '',
                            lat: parseFloat(row.latitude_deg),
                            lon: parseFloat(row.longitude_deg)
                        }
                    }
                };
            }).filter(op => op !== null);

            batch = [];
            if (ops.length > 0) {
                try {
                    await AirportDictionary.bulkWrite(ops, { ordered: false });
                    totalInserted += ops.length;
                    console.log(`[OSINT] Inserted ${totalInserted} airports so far...`);
                } catch (e) {
                    // Ignore 11000 duplicate key error
                    if (e.code !== 11000) console.error('[OSINT] Bulk write error:', e.message);
                }
            }
            if (isFinal) {
                console.log(`[OSINT] Successfully imported ${totalInserted} airports.`);
                if (fs.existsSync(TEMP_AIRPORTS_CSV)) fs.unlinkSync(TEMP_AIRPORTS_CSV);
                resolve();
            }
        };

        const readStream = fs.createReadStream(TEMP_AIRPORTS_CSV);
        readStream.pipe(csv())
            .on('data', async (row) => {
                batch.push(row);
                if (batch.length >= BATCH_SIZE) {
                    readStream.pause();
                    await processBatch();
                    readStream.resume();
                }
            })
            .on('end', async () => {
                await processBatch(true);
            })
            .on('error', reject);
    });
}

async function syncRoutes() {
    const count = await RouteDictionary.countDocuments();
    if (count > 0) {
        console.log(`[OSINT] RouteDictionary already has ${count} records. Skipping sync.`);
        return;
    }
    console.log(`[OSINT] Downloading routes data from ${ROUTES_URL}...`);
    await downloadFile(ROUTES_URL, TEMP_ROUTES_CSV);
    console.log(`[OSINT] Finished downloading routes. Parsing and inserting...`);

    return new Promise((resolve, reject) => {
        let batch = [];
        const BATCH_SIZE = 10000;
        let totalInserted = 0;

        const processBatch = async (isFinal = false) => {
            if (batch.length === 0) return;
            const ops = batch.map(row => {
                const callsign = row['Callsign'] || row['Route'];
                const origin = row['From'];
                const dest = row['To'];

                if (!callsign || !origin || !dest) return null;

                return {
                    insertOne: {
                        document: {
                            callsign: callsign.trim().toUpperCase(),
                            originIata: origin.trim().toUpperCase(),
                            destinationIata: dest.trim().toUpperCase()
                        }
                    }
                };
            }).filter(op => op !== null);

            batch = [];
            if (ops.length > 0) {
                try {
                    await RouteDictionary.bulkWrite(ops, { ordered: false });
                    totalInserted += ops.length;
                    console.log(`[OSINT] Inserted ${totalInserted} routes so far...`);
                } catch (e) {
                    if (e.code !== 11000) console.error('[OSINT] Bulk write error:', e.message);
                }
            }
            if (isFinal) {
                console.log(`[OSINT] Successfully imported ${totalInserted} routes.`);
                if (fs.existsSync(TEMP_ROUTES_CSV)) fs.unlinkSync(TEMP_ROUTES_CSV);
                resolve();
            }
        };

        const readStream = fs.createReadStream(TEMP_ROUTES_CSV);
        readStream.pipe(csv())
            .on('data', async (row) => {
                batch.push(row);
                if (batch.length >= BATCH_SIZE) {
                    readStream.pause();
                    await processBatch();
                    readStream.resume();
                }
            })
            .on('end', async () => {
                await processBatch(true);
            })
            .on('error', reject);
    });
}

async function initOsintData() {
    try {
        await syncAirports();
        await syncRoutes();
        console.log(`✅ [OSINT] Initialization Complete.`);
    } catch (err) {
        console.error(`❌ [OSINT] Initialization Failed:`, err.message);
    }
}

module.exports = { initOsintData };
