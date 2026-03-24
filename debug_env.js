const path = require('path');
const dotenv = require('dotenv');
const envPath = path.join(__dirname, 'backend', '.env');
const result = dotenv.config({ path: envPath });

console.log('Env Path:', envPath);
if (result.error) {
  console.error('Dotenv Error:', result.error);
} else {
  console.log(' Dotenv loaded successfully');
}

console.log('MONGODB_URI:', process.env.MONGODB_URI);
console.log('All process.env keys:', Object.keys(process.env).filter(k => k.includes('MONGO')));
