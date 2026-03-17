const mongoose = require('mongoose');

/**
 * TrackPoint Schema - Optimized for MongoDB Time Series
 * This collection will store high-frequency aircraft coordinate updates.
 */
const trackPointSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        index: true
    },
    icao24: {
        type: String,
        required: true,
        index: true
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
    onGround: {
        type: Boolean,
        default: false
    }
}, {
    // Time Series optimization (MongoDB 5.0+)
    timeseries: {
        timeField: 'timestamp',
        metaField: 'sessionId',
        granularity: 'seconds'
    }
});

// TTL Index: Automatically delete data older than 24 hours (86400 seconds)
trackPointSchema.index({ timestamp: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('TrackPoint', trackPointSchema);
