const axios = require('axios');

async function checkLivePlanes() {
    try {
        const res = await axios.get('http://localhost:3000/api/flights/live');
        const planes = res.data;
        console.log(`Total planes: ${planes.length}`);
        
        const samples = planes.slice(0, 5);
        samples.forEach(p => {
            console.log(`ICAO24: ${p.icao24}, Callsign: ${p.callsign}, Type: ${p.typecode || 'MISSING'}, Category: ${p.category}`);
        });
    } catch (err) {
        console.error('Failed to fetch live planes:', err.message);
    }
}

checkLivePlanes();
