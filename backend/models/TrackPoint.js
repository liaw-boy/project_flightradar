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
        required: true
        // No index: true here — timeField is auto-indexed by MongoDB time-series engine
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

// TTL for time-series collections is controlled by expireAfterSeconds in the timeseries
// options above (set at collection creation), NOT via schema.index(). Do not add a TTL
// index here — it will cause duplicate index warnings and MongoDB will reject it.

module.exports = mongoose.model('TrackPoint', trackPointSchema);
