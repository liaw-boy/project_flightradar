const mongoose = require('mongoose');

const airlineSchema = new mongoose.Schema({
    icao: {
        type: String,
        required: true,
        unique: true,
        index: true,
        uppercase: true,
        minlength: 3,
        maxlength: 3
    },
    name: {
        type: String,
        required: true
    },
    country: {
        type: String
    },
    logo: {
        type: String // URL to logo
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Airline', airlineSchema);
