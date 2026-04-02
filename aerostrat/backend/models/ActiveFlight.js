const mongoose = require('mongoose');

const activeFlightSchema = new mongoose.Schema({
    hex: { type: String, required: true, unique: true, index: true },
    callsign: { type: String, default: '' },
    current_state: {
        lat: Number,
        lon: Number,
        alt: Number,
        hdg: Number,
        gs: Number
    },
    trace: [{
        lat: Number,
        lon: Number,
        alt: Number,
        timestamp: Date
    }],
    last_updated_at: { type: Date, default: Date.now, index: { expires: 86400 } }
});

module.exports = mongoose.model('ActiveFlight', activeFlightSchema);
