const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const path = require('path');

async function peek() {
    const fileStream = fs.createReadStream(path.join(__dirname, '..', 'data', 'aircraft.csv.gz'));
    const gunzip = zlib.createGunzip();
    const rl = readline.createInterface({
        input: fileStream.pipe(gunzip),
        terminal: false
    });

    let count = 0;
    for await (const line of rl) {
        console.log(line);
        count++;
        if (count > 5) break;
    }
}

peek();
