const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const envPath = path.join(__dirname, '.env');
console.log('Checking existence of:', envPath);
console.log('Exists:', fs.existsSync(envPath));

const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error('Dotenv Error:', result.error);
} else {
  console.log('Dotenv loaded successfully');
}

console.log('MONGODB_URI:', process.env.MONGODB_URI);
console.log('All process.env keys with MONGO:', Object.keys(process.env).filter(k => k.includes('MONGO')));
