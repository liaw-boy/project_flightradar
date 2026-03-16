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
    lat: {
        type: Number,
        required: true
    },
    lng: {
        type: Number,
        required: true
    }
}, {
    timestamps: true
});

// [GIS Optimization] 空間索引：加速近接機場搜尋與 O/D 推論
airportSchema.index({ lat: 1, lng: 1 });

module.exports = mongoose.model('Airport', airportSchema);
