const mongoose = require('mongoose');

/**
 * TrackPoint Schema - Optimized for MongoDB Time Series
 * This collection stores high-frequency aircraft coordinate updates.
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
        required: true,
        index: true
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
    geo_altitude: {
        type: Number,
        default: null
    },
    velocity: {
        type: Number,
        default: 0
    },
    heading: {
        type: Number,
        default: 0
    },
    vertical_rate: {
        type: Number,
        default: null
    },
    onGround: {
        type: Boolean,
        default: false
    },
    squawk: {
        type: String,
        default: null
    }
}, {
    // Time Series optimization (MongoDB 5.0+)
    timeseries: {
        timeField: 'timestamp',
        metaField: 'sessionId', // Use sessionId as the metaField for better grouping
        granularity: 'seconds'
    }
});

// Add a TTL index to prevent disk exhaustion if needed
trackPointSchema.index({ timestamp: 1 }, { expireAfterSeconds: 86400 * 3 }); // Keep for 3 days

module.exports = mongoose.model('TrackPoint', trackPointSchema);
