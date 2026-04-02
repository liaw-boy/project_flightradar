const mongoose = require('mongoose');

/**
 * AircraftShape — 儲存來自 AircraftShapesSVG (GPLv3) 的飛機輪廓 SVG 資料。
 * 由 scripts/seedAircraftShapes.js 一次性種入，前端透過 /api/aircraft-shapes 讀取。
 */
const aircraftShapeSchema = new mongoose.Schema({
    typecode: {
        type: String,
        required: true,
        uppercase: true,
        unique: true,
        index: true
    },
    viewBox: {
        type: String,
        required: true
    },
    paths: {
        type: [String],
        required: true
    },
    scale: {
        type: Number,
        default: 1.0
    },
    category: {
        type: String,
        enum: ['JUMBO', 'WIDE', 'NARROW', 'REGIONAL', 'LIGHT', 'HELI', 'MILITARY', 'UNKNOWN'],
        default: 'UNKNOWN'
    }
}, { timestamps: false, versionKey: false });

module.exports = mongoose.model('AircraftShape', aircraftShapeSchema);
