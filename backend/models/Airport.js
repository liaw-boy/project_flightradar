const mongoose = require('mongoose');

const airportSchema = new mongoose.Schema({
<<<<<<< HEAD:backend/models/Airport.js
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
=======
    icao: {
        type: String,
        unique: true,
        sparse: true,
        uppercase: true,
        trim: true,
        minlength: 4,
        maxlength: 4
    },
    iata: {
        type: String,
        index: true,
        sparse: true,
        uppercase: true,
        trim: true,
        minlength: 3,
        maxlength: 3
    },
    name: {
        type: String,
        required: true
    },
    city: {
        type: String
    },
    country: {
        type: String
    },
    // [GIS MODERNIZATION] 使用 GeoJSON Point 替代獨立的 lat/lng
    location: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point'
        },
        coordinates: {
            type: [Number], // [longitude, latitude]
            required: true
        }
    }
}, {
    timestamps: true
});

// [GIS Optimization] 2dsphere 索引：解鎖極速球面距離查詢與 $near 演算
airportSchema.index({ location: "2dsphere" });
>>>>>>> 7dd1d16eafdaccb34ea04849a1462e04db3c9934:models/Airport.js

module.exports = mongoose.model('Airport', airportSchema);
