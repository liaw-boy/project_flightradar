const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb://127.0.0.1:27018/aerostrat';

const AircraftSchema = new mongoose.Schema({
    icao24: { type: String, required: true, unique: true, index: true },
    registration: String,
    manufacturerName: String,
    model: String,
    typecode: String,
    owner: String,
    operatorCallsign: String,
    noData: Boolean,
    lastUpdated: Date
});

const Aircraft = mongoose.model('Aircraft', AircraftSchema);

async function fix() {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');
    
    // Forced update for JAL736
    const result = await Aircraft.findOneAndUpdate(
        { icao24: '86dca2' },
        { 
            registration: 'JA864J',
            typecode: 'B789',
            model: 'Boeing 787-9 Dreamliner',
            manufacturerName: 'Boeing',
            noData: false,
            lastUpdated: new Date()
        },
        { upsert: true, new: true }
    );
    console.log('Updated 86dca2:', result);
    
    await mongoose.disconnect();
}

fix();
