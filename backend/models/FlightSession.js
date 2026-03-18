const mongoose = require('mongoose');

const flightSessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    icao24: {
        type: String,
        required: true,
        index: true
    },
    callsign: {
        type: String,
        default: null,
        index: true
    },
    startTime: {
        type: Date,
        default: Date.now
    },
    endTime: {
        type: Date,
        default: null
    },
    status: {
        type: String,
        enum: ['ACTIVE', 'COMPLETED', 'TIMEOUT'],
        default: 'ACTIVE'
    }
});

module.exports = mongoose.model('FlightSession', flightSessionSchema);
