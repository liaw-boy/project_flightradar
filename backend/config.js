const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const config = {
    PORT: process.env.PORT || 3000,
};

module.exports = config;
