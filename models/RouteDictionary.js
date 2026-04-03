const mongoose = require('mongoose');

const routeDictionarySchema = new mongoose.Schema({
    callsign: { type: String, required: true, unique: true, index: true },
    originIata: { type: String },
    destinationIata: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('RouteDictionary', routeDictionarySchema);
