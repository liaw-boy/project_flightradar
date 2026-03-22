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
    // [v11] DB-First Professional Fields
    hex: { type: String, index: true }, // Alias for icao24
    type: { type: String, default: '' }, // Alias for model/typecode
    manufacturer: { type: String, default: '' },
    registration: { type: String, default: '' },
    airline: { type: String, default: '' },
    photo_url: { type: String, default: null },
    
    photoData: {
        url: { type: String, default: null },
        thumbnail: { type: String, default: null },
        photographer: { type: String, default: null },
        link: { type: String, default: null },
        lastUpdated: { type: Date, default: null }
    },
    specs: {
        engines: { type: String, default: '' },
        capacity: { type: Number, default: 0 }
    },
    registered_owner: { type: String, default: '' }, 
    lastUpdated: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now, index: { expires: '30d' } }
});



module.exports = mongoose.model('Aircraft', AircraftSchema);
