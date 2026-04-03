const mongoose = require('mongoose');
const uri = process.env.MONGODB_URI || 'mongodb://mongodb:27017/aerostrat';
console.log('Testing connection to:', uri);
mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 })
  .then(() => {
    console.log('SUCCESS: Connected to MongoDB');
    process.exit(0);
  })
  .catch(err => {
    console.error('FAILURE: Could not connect to MongoDB:', err.message);
    process.exit(1);
  });
