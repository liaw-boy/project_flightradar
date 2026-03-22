const mongoose = require('mongoose');
const MONGODB_URI = 'mongodb://127.0.0.1:27017/aerostrat';

async function query() {
    await mongoose.connect(MONGODB_URI);
    const TrackPoint = mongoose.model('TrackPoint', new mongoose.Schema({
        icao24: String,
        timestamp: Date
    }));
    const FlightSession = mongoose.model('FlightSession', new mongoose.Schema({
        icao24: String,
        callsign: String,
        startTime: Date
    }));

    const lastPoint = await TrackPoint.findOne().sort({ timestamp: -1 }).lean();
    if (!lastPoint) {
        console.log('No track points found.');
        process.exit(0);
    }

    const session = await FlightSession.findOne({ icao24: lastPoint.icao24 }).sort({ startTime: -1 }).lean();
    console.log(JSON.stringify({
        hex: lastPoint.icao24,
        callsign: session ? session.callsign : 'N/A',
        timestamp: lastPoint.timestamp
    }, null, 2));
    process.exit(0);
}

query().catch(err => {
    console.error(err);
    process.exit(1);
});
