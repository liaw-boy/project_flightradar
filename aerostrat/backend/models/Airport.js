const mongoose = require('mongoose');

const airportSchema = new mongoose.Schema({
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

module.exports = mongoose.model('Airport', airportSchema);
