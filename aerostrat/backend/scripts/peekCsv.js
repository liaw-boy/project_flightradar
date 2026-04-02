const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');

const inputStream = fs.createReadStream('g:/project_flightradar/backend/data/aircraft.csv.gz');
const gunzip = zlib.createGunzip();
const lineReader = readline.createInterface({
    input: inputStream.pipe(gunzip),
    terminal: false
});

let count = 0;
lineReader.on('line', (line) => {
    console.log(line);
    count++;
    if (count >= 5) {
        process.exit(0);
    }
});
