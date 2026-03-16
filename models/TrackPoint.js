const mongoose = require('mongoose');

/**
 * TrackPoint Schema - Optimized for MongoDB Time Series
 * This collection will store high-frequency aircraft coordinate updates.
 */
const trackPointSchema = new mongoose.Schema({
    icao24: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        required: true
    },
    lat: {
        type: Number,
        required: true
    },
    lng: {
        type: Number,
        required: true
    },
    altitude: {
        type: Number,
        default: 0
    },
    velocity: {
        type: Number,
        default: 0
    },
    heading: {
        type: Number,
        default: 0
    },
    createdAt: { // [Task 2] TTL 磁碟空間守衛
        type: Date,
        default: Date.now,
        index: { expires: '24h' }
    }
}, {
    // Time Series optimization (MongoDB 5.0+)
    timeseries: {
        timeField: 'timestamp',
        metaField: 'icao24',
        granularity: 'seconds'
    }
});

module.exports = mongoose.model('TrackPoint', trackPointSchema);
