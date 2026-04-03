const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const config = {
    PORT: process.env.PORT || 3000,
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aerostrat',
};

module.exports = config;
