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
    // [v12.0] High-Performance UI Integration
    hex: { type: String, unique: true, index: true, lowercase: true, trim: true }, // [MANDATORY] Unique HEX Index
    registration: { type: String, default: '' },
    type_code: { type: String, default: '', index: true }, // [MANDATORY] ICAO Type Code (e.g. B738)
    operator: { type: String, default: '' }, // [MANDATORY] Airline/Operator
    icon_type: { type: String, default: 'STANDARD_JET', index: true }, // [MANDATORY] Pre-calculated Sidebar/Map icon key
    
    manufacturer: { type: String, default: '' },
    airline: { type: String, default: '' }, // Legacy alias for operator
    photo_url: { type: String, default: null },
    photographer: { type: String, default: null },

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
    updatedAt: { type: Date, default: Date.now, index: { expires: '90d' } } // Extended persistence to 90 days
});



module.exports = mongoose.model('Aircraft', AircraftSchema);
