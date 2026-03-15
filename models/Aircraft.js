const mongoose = require('mongoose');

const AircraftSchema = new mongoose.Schema({
    icao24: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    registration: { type: String, default: '' },
    manufacturerName: { type: String, default: '' },
    model: { type: String, default: '' },
    typecode: { type: String, default: '' },
    owner: { type: String, default: '' },
    operatorCallsign: { type: String, default: '' },
    built: { type: String, default: '' },
    categoryDescription: { type: String, default: '' },
    photoUrl: { type: String, default: null }, // Future expansion
    lastUpdated: { type: Date, default: Date.now }
});



module.exports = mongoose.model('Aircraft', AircraftSchema);
