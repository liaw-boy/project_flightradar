const mongoose = require('mongoose');

const RouteSchema = new mongoose.Schema({
    callsign: {
        type: String,
        required: true,
        unique: true, // 確保呼號唯一，建立索引加速查詢
        uppercase: true,
        trim: true
    },
    departureAirport: {
        type: String, // 可以是 ICAO 或 IATA 碼
        default: null
    },
    arrivalAirport: {
        type: String,
        default: null
    },
    // [v9.0] Phase 9 DB-First alignment
    origin_iata: { type: String, default: null },
    destination_iata: { type: String, default: null },
    estimated_arrival_time: { type: String, default: null },
    // [v11] DB-First Professional Fields
    destination_weather: { type: Object, default: null }, // Stores METAR/Temp
    source: {
        type: String,
        default: 'manual'
    },
    lastUpdated: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now,
        index: { expires: '24h' }
    }
});

// 建立索引


module.exports = mongoose.model('Route', RouteSchema);
