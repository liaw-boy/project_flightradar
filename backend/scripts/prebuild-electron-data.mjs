#!/usr/bin/env node
// Regenerates the gitignored reference-data files a fresh clone doesn't
// have, so the Electron/macOS package ships a fully working offline app
// (no manual per-release data prep). Run from anywhere; paths below are
// pinned to backend/ regardless of cwd.
//
//   node backend/scripts/prebuild-electron-data.mjs
//
// Chains, in order:
//   1. download_data.js   -> data/iata_airlines.csv, iata_tz.csv, optd_por_public.csv
//   2. process_data.js    -> data/processed/{airlines,timezones,airports_global}.json
//   3. (this script)      -> data/raw_openflights.dat (OpenFlights routes.dat)
//   4. merge_routes.js    -> data/processed/{schedules_global,airline_prefixes}.json
//      (also needs data/raw_jonty.json, which has no known regeneration
//      source and is therefore committed to git rather than downloaded here)
//   5. git clone/pull vradarserver/standing-data -> data/standing-data/
//   6. build-routes-db.js -> data/routes.db
//   7. (this script)      -> data/aircraft.csv.gz (wiedehopf/tar1090-db)
'use strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(BACKEND_DIR, 'data');

const OPENFLIGHTS_ROUTES_URL =
    'https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat';
const TAR1090_AIRCRAFT_CSV_GZ_URL =
    'https://raw.githubusercontent.com/wiedehopf/tar1090-db/refs/heads/csv/aircraft.csv.gz';
const STANDING_DATA_REPO = 'https://github.com/vradarserver/standing-data.git';
const STANDING_DATA_DIR = path.join(DATA_DIR, 'standing-data');

function run(script) {
    console.log(`\n[prebuild] node backend/scripts/${script}`);
    execFileSync(process.execPath, [path.join(BACKEND_DIR, 'scripts', script)], {
        cwd: BACKEND_DIR,
        stdio: 'inherit',
    });
}

function download(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        https.get(url, { timeout: 60000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
                return download(res.headers.location, redirectsLeft - 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject).on('timeout', function () { this.destroy(new Error('Download timeout')); });
    });
}

async function downloadFile(url, destPath, label) {
    console.log(`\n[prebuild] Downloading ${label} from ${url}`);
    const buf = await download(url);
    fs.writeFileSync(destPath, buf);
    console.log(`[prebuild] Saved ${destPath} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

function ensureStandingDataClone() {
    if (fs.existsSync(path.join(STANDING_DATA_DIR, '.git'))) {
        console.log('\n[prebuild] standing-data already cloned, will be refreshed by syncVrsRoutes.js');
        return;
    }
    console.log(`\n[prebuild] git clone --depth 1 ${STANDING_DATA_REPO}`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    execFileSync('git', ['clone', '--depth', '1', STANDING_DATA_REPO, STANDING_DATA_DIR], {
        stdio: 'inherit',
    });
}

function assertNonEmpty(relPath) {
    const full = path.join(DATA_DIR, relPath);
    if (!fs.existsSync(full) || fs.statSync(full).size === 0) {
        throw new Error(`[prebuild] Sanity check failed: ${relPath} is missing or empty (${full})`);
    }
}

async function main() {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    run('download_data.js');
    run('process_data.js');

    await downloadFile(OPENFLIGHTS_ROUTES_URL, path.join(DATA_DIR, 'raw_openflights.dat'), 'OpenFlights routes.dat');

    if (!fs.existsSync(path.join(DATA_DIR, 'raw_jonty.json'))) {
        throw new Error(
            '[prebuild] backend/data/raw_jonty.json is missing. This dataset has no known ' +
            'automated source and is committed to git — check it out with the rest of the repo ' +
            'rather than relying on this script to produce it.'
        );
    }

    run('merge_routes.js');

    ensureStandingDataClone();
    run('syncVrsRoutes.js');
    run('build-routes-db.js');

    await downloadFile(TAR1090_AIRCRAFT_CSV_GZ_URL, path.join(DATA_DIR, 'aircraft.csv.gz'), 'tar1090-db aircraft.csv.gz');

    console.log('\n[prebuild] Sanity checks...');
    assertNonEmpty('routes.db');
    assertNonEmpty('aircraft.csv.gz');
    assertNonEmpty(path.join('standing-data', 'routes'));
    assertNonEmpty(path.join('processed', 'schedules_global.json'));
    console.log('[prebuild] All data files present. Done.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
