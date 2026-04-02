const mongoose = require('mongoose');

const MetarSchema = new mongoose.Schema({
    icaoId: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true
    },
    iataId: { type: String, default: '' },
    name: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    country: { type: String, default: '' },
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
    location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], default: [0, 0] } // [lng, lat]
    },
    elev: { type: Number, default: null },
    temp: { type: String, default: '' },
    dewp: { type: String, default: '' },
    wspd: { type: String, default: '' },
    wdir: { type: String, default: '' },
    wgst: { type: String, default: '' },
    visib: { type: String, default: '' },
    altim: { type: String, default: '' },
    slp: { type: String, default: '' },
    fltCat: { type: String, default: '' }, // [v4.2.1] VFR/MVFR/IFR
    clouds: { type: Array, default: [] }, // [v4.2.1] [{cover, base}, ...]
    rawOb: { type: String, default: '' },
    receiptTime: { type: Date, default: null },
    obsTime: { type: Date, default: null }, // Mapped from Unix timestamp
    lastUpdated: { type: Date, default: Date.now }
});

MetarSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Metar', MetarSchema);
