const mongoose = require('mongoose');
require('dotenv').config();
const Airline = require('./models/Airline');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat';

const airlinesData = [
    { icao: 'EVA', name: 'EVA Air', country: 'Taiwan', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/e/e0/EVA_Air_logo.svg/512px-EVA_Air_logo.svg.png' },
    { icao: 'CAL', name: 'China Airlines', country: 'Taiwan', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/China_Airlines_Logo.svg/512px-China_Airlines_Logo.svg.png' },
    { icao: 'CPA', name: 'Cathay Pacific', country: 'Hong Kong', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f0/Cathay_Pacific_logo.svg/512px-Cathay_Pacific_logo.svg.png' },
    { icao: 'JAL', name: 'Japan Airlines', country: 'Japan', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/Japan_Airlines_logo_%282011%29.svg/512px-Japan_Airlines_logo_%282011%29.svg.png' },
    { icao: 'ANA', name: 'All Nippon Airways', country: 'Japan', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/All_Nippon_Airways_Logo.svg/512px-All_Nippon_Airways_Logo.svg.png' },
    { icao: 'SIA', name: 'Singapore Airlines', country: 'Singapore', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/6/6b/Singapore_Airlines_Logo_2.svg/512px-Singapore_Airlines_Logo_2.svg.png' },
    { icao: 'DAL', name: 'Delta Air Lines', country: 'USA', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d1/Delta_logo.svg/512px-Delta_logo.svg.png' },
    { icao: 'KAL', name: 'Korean Air', country: 'South Korea', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/22/Logo_Korean_Air.svg/512px-Logo_Korean_Air.svg.png' },
    { icao: 'UAE', name: 'Emirates', country: 'UAE', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d0/Emirates_logo.svg/512px-Emirates_logo.svg.png' },
    { icao: 'THA', name: 'Thai Airways', country: 'Thailand', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/Thai_Airways_Logo.svg/512px-Thai_Airways_Logo.svg.png' },
    { icao: 'MAS', name: 'Malaysia Airlines', country: 'Malaysia', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/Malaysia_Airlines_Logo.svg/512px-Malaysia_Airlines_Logo.svg.png' },
    { icao: 'AFR', name: 'Air France', country: 'France', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/Air_France_2009_logo.svg/512px-Air_France_2009_logo.svg.png' },
    { icao: 'BAW', name: 'British Airways', country: 'UK', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/3/36/British_Airways_Logo.svg/512px-British_Airways_Logo.svg.png' },
    { icao: 'DLH', name: 'Lufthansa', country: 'Germany', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/af/Lufthansa_Logo_2018.svg/512px-Lufthansa_Logo_2018.svg.png' },
    { icao: 'QFA', name: 'Qantas', country: 'Australia', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/2/29/Qantas_Logo_2016.svg/512px-Qantas_Logo_2016.svg.png' },
    { icao: 'UAL', name: 'United Airlines', country: 'USA', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/e/e9/United_Airlines_Logo.svg/512px-United_Airlines_Logo.svg.png' },
    { icao: 'AAL', name: 'American Airlines', country: 'USA', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/0/0d/American_Airlines_logo_2013.svg/512px-American_Airlines_logo_2013.svg.png' },
    { icao: 'KLM', name: 'KLM', country: 'Netherlands', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c7/KLM_logo.svg/1024px-KLM_logo.svg.png' },
    { icao: 'FIN', name: 'Finnair', country: 'Finland', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Finnair_logo.svg/1024px-Finnair_logo.svg.png' },
    { icao: 'CSN', name: 'China Southern Airlines', country: 'China', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/c/c2/China_Southern_Airlines_logo.svg/512px-China_Southern_Airlines_logo.svg.png' }
];

async function seed() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('🌱 Connected to MongoDB for seeding...');
        
        await Airline.deleteMany({});
        console.log('🗑️ Existing airline data cleared.');
        
        await Airline.insertMany(airlinesData);
        console.log(`✅ Successfully seeded ${airlinesData.length} airlines!`);
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error);
        process.exit(1);
    }
}

seed();
