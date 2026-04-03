const mongoose = require('mongoose');

const airportDictionarySchema = new mongoose.Schema({
    iata: { type: String, index: true, sparse: true }, // Not all airports have IATA
    icao: { type: String, index: true, sparse: true }, // Not all airports have ICAO
    name: { type: String },
    city: { type: String },
    country: { type: String },
    lat: { type: Number },
    lon: { type: Number }
}, { timestamps: true });

// Prevent duplicate entries where both ICAO and IATA match
airportDictionarySchema.index({ iata: 1, icao: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('AirportDictionary', airportDictionarySchema);
