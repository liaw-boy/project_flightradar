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
    elev: { type: Number, default: null },
    temp: { type: String, default: '' },
    dewp: { type: String, default: '' },
    wspd: { type: String, default: '' },
    wdir: { type: String, default: '' },
    wgst: { type: String, default: '' },
    visib: { type: String, default: '' },
    altim: { type: String, default: '' },
    slp: { type: String, default: '' },
    rawOb: { type: String, default: '' },
    receiptTime: { type: Date, default: null },
    obsTime: { type: Number, default: null },
    lastUpdated: { type: Date, default: Date.now }
});



module.exports = mongoose.model('Metar', MetarSchema);
