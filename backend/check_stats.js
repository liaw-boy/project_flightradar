const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function checkStats() {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat';
    console.log('Connecting to:', MONGODB_URI);
    await mongoose.connect(MONGODB_URI);
    
    const db = mongoose.connection.db;
    
    const collections = await db.listCollections().toArray();
    console.log('\nCollections:');
    for (const coll of collections) {
        const count = await db.collection(coll.name).countDocuments();
        console.log(`- ${coll.name}: ${count} docs`);
    }

    // Check for specific airports mentioned by user
    const airports = db.collection('airports');
    const rctp = await airports.findOne({ $or: [{ icao: 'RCTP' }, { iata: 'TPE' }] });
    console.log('\nRCTP/TPE in DB:', rctp ? 'Found' : 'Not Found');
    if (rctp) console.log(JSON.stringify(rctp, null, 2));

    const rccm = await airports.findOne({ $or: [{ icao: 'RCCM' }, { iata: 'RCCM' }] });
    console.log('\nRCCM in DB:', rccm ? 'Found' : 'Not Found');
    if (rccm) console.log(JSON.stringify(rccm, null, 2));

    await mongoose.disconnect();
}

checkStats().catch(console.error);
