const mongoose = require('mongoose');
require('dotenv').config();
const Route = require('./models/Route');

async function checkMongoDB() {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat';
    await mongoose.connect(MONGODB_URI);
    
    const cal163 = await Route.findOne({ callsign: 'CAL163' }).lean();
    console.log('--- CAL163 ---');
    console.log(JSON.stringify(cal163, null, 2));

    const eva061 = await Route.findOne({ callsign: 'EVA061' }).lean();
    console.log('\n--- EVA061 ---');
    console.log(JSON.stringify(eva061, null, 2));

    const total = await Route.countDocuments();
    console.log('\nTotal Routes:', total);

    const sources = await Route.aggregate([
        { $group: { _id: "$source", count: { $sum: 1 } } }
    ]);
    console.log('\nSources Breakdown:');
    console.log(JSON.stringify(sources, null, 2));

    await mongoose.disconnect();
}

checkMongoDB();
