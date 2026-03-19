const mongoose = require('mongoose');

const AircraftRegistrySchema = new mongoose.Schema({
    icao24: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    registration: { type: String, default: '' },
    model: { type: String, default: '' },
    engineType: { type: String, default: '' },
    firstFlightDate: { type: String, default: '' },
    age: { type: Number, default: null },
    airline: { type: String, default: '' },
    isLeased: { type: Boolean, default: false },
    notFound: { type: Boolean, default: false },
    apiStatus: { type: String, enum: ['OK', 'BLOCKED'], default: 'OK' }, // [熔斷機制]
    blockedUntil: { type: Date, default: null }, // [熔斷機制]
    lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AircraftRegistry', AircraftRegistrySchema);
