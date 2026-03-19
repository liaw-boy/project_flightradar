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
    // [AI EVOLUTION] 紀錄航線來源：'manual', 'aerodatabox', 'ai_learned'
    source: {
        type: String,
        default: 'manual'
    },
    lastUpdated: {
        type: Date,
        default: Date.now
    }
});

// 建立索引


module.exports = mongoose.model('Route', RouteSchema);
