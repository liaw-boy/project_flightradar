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
<<<<<<< HEAD:backend/models/FlightSession.js
        default: null,
=======
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:models/FlightSession.js
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
<<<<<<< HEAD:backend/models/FlightSession.js
        enum: ['ACTIVE', 'COMPLETED', 'TIMEOUT'],
        default: 'ACTIVE'
    }
=======
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
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:models/FlightSession.js
});

module.exports = mongoose.model('FlightSession', flightSessionSchema);
