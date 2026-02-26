const https = require('https');
const fs = require('fs');

console.log('Downloading airports.json...');
https.get('https://raw.githubusercontent.com/mwgg/Airports/master/airports.json', (res) => {
    let rawData = '';
    res.on('data', (chunk) => rawData += chunk);
    res.on('end', () => {
        try {
            const db = JSON.parse(rawData);

            // Map ICAO -> { iata, city }
            const mapping = {};
            for (const icao in db) {
                const iata = db[icao].iata;
                if (iata && iata !== '\\N' && iata !== '') {
                    const city = (db[icao].city || db[icao].name || '').split(',')[0].toUpperCase();
                    mapping[icao.toUpperCase()] = { iata, city };
                }
            }

            let out = `// Generated comprehensive airport mappings\n`;
            out += `export const AIRPORT_IATA_DB = ${JSON.stringify(mapping, null, 2)};\n\n`;
            out += `export function getAirportDisplayData(icao) {\n`;
            out += `    if (!icao || icao.length !== 4) return { code: icao || 'N/A', city: '' };\n`;
            out += `    const upper = icao.toUpperCase();\n`;
            out += `    if (AIRPORT_IATA_DB[upper]) {\n`;
            out += `        return { code: AIRPORT_IATA_DB[upper].iata, city: AIRPORT_IATA_DB[upper].city };\n`;
            out += `    }\n`;
            out += `    return { code: upper, city: '' };\n`;
            out += `}\n`;

            fs.writeFileSync('g:/project_flightradar/client/src/utils/airportMappings.js', out);
            console.log('Successfully written ' + Object.keys(mapping).length + ' airports to airportMappings.js');
        } catch (e) {
            console.error('JSON Parse error: ' + e.message);
        }
    });
}).on('error', (e) => {
    console.error('Download error: ' + e.message);
});
