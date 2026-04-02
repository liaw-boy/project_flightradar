const https = require('https');
const fs = require('fs');
const path = require('path');

const files = [
    { url: 'https://raw.githubusercontent.com/benct/iata-utils/master/generated/iata_airlines.csv', dest: 'data/iata_airlines.csv' },
    { url: 'https://raw.githubusercontent.com/benct/iata-utils/master/generated/iata_tz.csv', dest: 'data/iata_tz.csv' },
    { url: 'https://raw.githubusercontent.com/opentraveldata/opentraveldata/master/opentraveldata/optd_por_public.csv', dest: 'data/optd_por_public.csv' }
];

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

function download(file) {
    return new Promise((resolve, reject) => {
        console.log(`Downloading ${file.url}...`);
        const request = https.get(file.url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                download({ url: response.headers.location, dest: file.dest }).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download ${file.url}: Code ${response.statusCode}`));
                return;
            }
            const fileStream = fs.createWriteStream(path.join(process.cwd(), file.dest));
            response.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close();
                console.log(`Successfully saved to ${file.dest}`);
                resolve();
            });
        });
        request.on('error', (err) => {
            reject(err);
        });
        request.setTimeout(30000, () => {
            request.destroy();
            reject(new Error(`Timeout downloading ${file.url}`));
        });
    });
}

async function start() {
    for (const file of files) {
        try {
            await download(file);
        } catch (e) {
            console.error(`Error downloading ${file.url}:`, e.message);
        }
    }
    console.log('Download process finished.');
}

start();
