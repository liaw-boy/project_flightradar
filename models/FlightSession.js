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
        enum: ['ACTIVE', 'COMPLETED'],
        default: 'ACTIVE',
        index: true
    },
    departureAirport: {
        type: String,
        default: null
    },
    arrivalAirport: {
        type: String,
        default: null
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('FlightSession', flightSessionSchema);
