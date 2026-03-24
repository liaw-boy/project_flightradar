const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb://127.0.0.1:27018/aerostrat';
const s = { icao24: String, registration: String, typecode: String, model: String };
const Aircraft = mongoose.models.Aircraft || mongoose.model('Aircraft', new mongoose.Schema(s));

async function run() {
    await mongoose.connect(MONGODB_URI);
    const icao = '86dca2';
    await Aircraft.findOneAndUpdate({ icao24: icao }, {
        registration: 'JA864J',
        typecode: 'B789',
        model: 'Boeing 787-9 Dreamliner'
    }, { upsert: true });
    
    const check = await Aircraft.findOne({ icao24: icao });
    console.log('VERIFIED:', JSON.stringify(check));
    process.exit();
}
run();
