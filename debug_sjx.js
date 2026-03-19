const mongoose = require('mongoose');
require('dotenv').config();
const Route = require('./models/Route');

async function checkSJX805() {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat';
    await mongoose.connect(MONGODB_URI);
    
    console.log('Searching for SJX805...');
    const sjx805 = await Route.findOne({ callsign: 'SJX805' }).lean();
    console.log('Direct Search (SJX805):', sjx805);

    const regexSearch = await Route.findOne({ callsign: /^SJX805$/i }).lean();
    console.log('Regex Search (^SJX805$i):', regexSearch);

    const starluxSearch = await Route.find({ callsign: /^JX/i }).limit(5).lean();
    console.log('Sample Starlux (JX):', starluxSearch);

    await mongoose.disconnect();
}

checkSJX805();
