/**
 * seedAircraftShapes.js
 *
 * Reads preprocessed aircraft shape data from the local build output
 * and upserts all 182 shapes into MongoDB with scale/category fields.
 *
 * Usage (from backend/ directory):
 *   npm run seed-shapes
 *
 * Source: AircraftShapesSVG (GPLv3) by RexKramer1
 * Preprocessor: scripts/build-aircraft-shapes.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const AircraftShape = require('../models/AircraftShape');

const { execSync } = require('child_process');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018/aerostrat';

// Docker-aware path resolution
const isDocker = fs.existsSync('/.dockerenv');
const DATA_FILE = isDocker 
    ? path.join(__dirname, '..', 'data', 'aircraftShapesData.js')
    : path.resolve(__dirname, '../../client/src/data/aircraftShapesData.js');
const BUILD_SCRIPT = isDocker
    ? path.join(__dirname, '..', 'scripts-root', 'build-aircraft-shapes.js')
    : path.resolve(__dirname, '../../scripts/build-aircraft-shapes.js');

// Ensure data directory exists in Docker
if (isDocker && !fs.existsSync(path.dirname(DATA_FILE))) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

function loadShapesFromBuild() {
    // Auto-generate data file if it doesn't exist
    if (!fs.existsSync(DATA_FILE)) {
        console.log('   Data file not found. Running build-aircraft-shapes.js...\n');
        execSync(`node "${BUILD_SCRIPT}"`, { stdio: 'inherit' });
    }
    const code = fs.readFileSync(DATA_FILE, 'utf-8');
    const match = code.match(/const AIRCRAFT_SHAPES = ({[\s\S]*});/);
    if (!match) throw new Error('Cannot parse AIRCRAFT_SHAPES from ' + DATA_FILE);
    return JSON.parse(match[1]);
}

async function main() {
    console.log('\n  AEROSTRAT Aircraft Shape Seeder (Local Build)');
    console.log('   Source: AircraftShapesSVG (GPLv3) preprocessed data\n');

    const shapesMap = loadShapesFromBuild();
    const typecodes = Object.keys(shapesMap);
    console.log(`   Loaded ${typecodes.length} shapes from build output.\n`);

    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('   Connected to MongoDB\n');

    const ops = typecodes.map(tc => {
        const s = shapesMap[tc];
        return {
            updateOne: {
                filter: { typecode: tc },
                update: {
                    $set: {
                        typecode: tc,
                        viewBox: s.viewBox,
                        paths: s.paths,
                        scale: s.scale,
                        category: s.category,
                    }
                },
                upsert: true
            }
        };
    });

    console.log(`   Writing ${ops.length} shapes to MongoDB...`);
    const result = await AircraftShape.bulkWrite(ops, { ordered: false });
    console.log(`   Upserted: ${result.upsertedCount}, Modified: ${result.modifiedCount}`);
    console.log(`\n   Done: ${typecodes.length} aircraft shapes persisted.\n`);

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('\n   Fatal error:', err.message);
    mongoose.disconnect();
    process.exit(1);
});
