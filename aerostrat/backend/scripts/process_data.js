const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const OUTPUT_DIR = path.join(process.cwd(), 'data/processed');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

function parseCSV(filePath, delimiter = '^') {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim() !== '');
    return lines.map(line => line.split(delimiter));
}

// 1. Process Airlines (IATA to ICAO)
// iata_airlines.csv: BA^BAW^British Airways^
function processAirlines() {
    console.log('Processing Airlines...');
    const rows = parseCSV(path.join(DATA_DIR, 'iata_airlines.csv'));
    const airlineMap = {};
    rows.forEach(row => {
        if (row.length >= 3) {
            const iata = row[0]?.trim();
            const icao = row[1]?.trim();
            const name = row[2]?.trim();
            if (iata && icao) {
                airlineMap[iata] = { icao, name };
                airlineMap[icao] = { iata, name }; // Double map for bi-directional lookup
            }
        }
    });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'airlines.json'), JSON.stringify(airlineMap, null, 2));
    console.log(`Saved ${Object.keys(airlineMap).length} airline mappings.`);
}

// 2. Process Timezones
// iata_tz.csv: LHR^Europe/London
function processTimezones() {
    console.log('Processing Timezones...');
    const rows = parseCSV(path.join(DATA_DIR, 'iata_tz.csv'));
    const tzMap = {};
    rows.forEach(row => {
        if (row.length >= 2) {
            const iata = row[0]?.trim();
            const tz = row[1]?.trim();
            if (iata && tz) tzMap[iata] = tz;
        }
    });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'timezones.json'), JSON.stringify(tzMap, null, 2));
    console.log(`Saved ${Object.keys(tzMap).length} timezone mappings.`);
}

// 3. Process Airports (optd_por_public.csv)
// iata_code^icao_code^...^name^...^latitude^longitude
function processAirports() {
    console.log('Processing Airports...');
    const rows = parseCSV(path.join(DATA_DIR, 'optd_por_public.csv'), '^');
    const airports = {};

    rows.forEach((cols, index) => {
        if (index === 0) return;
        if (cols.length < 10) return;

        const iata = cols[0]?.trim().toUpperCase();
        const icao = cols[1]?.trim().toUpperCase();
        const name = cols[6]?.trim();
        const lat = parseFloat(cols[8]);
        const lng = parseFloat(cols[9]);
        const timezone = cols[31]?.trim();
        const country = cols[18]?.trim();
        const city = cols[37]?.split('|')[0]?.trim() || name;

        // Validation & Cleanup: Ensure we don't have empty critical strings
        if (!name && !city && !iata && !icao) return;

        const airportData = {
            icao: icao || null,
            iata: iata || null,
            name: name || city || "Unknown Airport",
            city: city || name || "Unknown City",
            country: country || "Unknown Country",
            lat: !isNaN(lat) ? lat : 0,
            lng: !isNaN(lng) ? lng : 0,
            timezone: timezone || null
        };

        if (icao && icao.length === 4) {
            airports[icao] = airportData;
        }
        if (iata && iata.length === 3) {
            // If we already have the record by ICAO, don't overwrite it with a potentially worse IATA one
            // unless the IATA one has more info (rare in this dataset)
            if (!airports[iata] || !airports[iata].icao) {
                airports[iata] = airportData;
            }
        }
    });

    fs.writeFileSync(path.join(OUTPUT_DIR, 'airports_global.json'), JSON.stringify(airports, null, 2));
    console.log(`Saved ${Object.keys(airports).length} airport records.`);
}

try {
    processAirlines();
    processTimezones();
    processAirports();
    console.log('All data processed successfully!');
} catch (e) {
    console.error('Process failed:', e.message);
}
