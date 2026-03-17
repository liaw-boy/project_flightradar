const mongoose = require('mongoose');

const airportSchema = new mongoose.Schema({
    icao: { type: String, required: true, unique: true, index: true },
    iata: { type: String, index: true },
    name: { type: String },
    city: { type: String },
    country: { type: String },
    location: {
        type: { type: String, enum: ['Point'], required: true, default: 'Point' },
        coordinates: { type: [Number], required: true } // [經度 lng, 緯度 lat]
    }
});

// 建立 2dsphere 空間索引，這是未來雷達範圍搜尋的核心
airportSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Airport', airportSchema);
