#!/usr/bin/env node
/**
 * AEROSTRAT Environment Pre-flight Check
 * Usage:  node check-env.js
 *         node check-env.js --start    (auto-start after passing)
 */
const fs   = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const ROOT    = __dirname;
const BACKEND = ROOT;
const CLIENT  = path.join(ROOT, 'client');
const AUTO_START = process.argv.includes('--start');

// ── Colour output ────────────────────────────────────────────────────────────
const C = {
    green:  s => `\x1b[32m${s}\x1b[0m`,
    red:    s => `\x1b[31m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`,
    bold:   s => `\x1b[1m${s}\x1b[0m`,
    dim:    s => `\x1b[2m${s}\x1b[0m`,
};

let pass = 0, fail = 0, warn = 0;

function ok(msg)   { console.log(C.green('  [OK  ] ') + msg); pass++; }
function bad(msg)  { console.log(C.red(  '  [FAIL] ') + msg); fail++; }
function caution(msg) { console.log(C.yellow('  [WARN] ') + msg); warn++; }
function section(title) { console.log(`\n${C.bold('── ' + title + ' ──────────────────────────────────────────')}`); }

function run(cmd) {
    try { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim(); }
    catch { return null; }
}

async function fetchJSON(url, timeoutMs = 6000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(url, { signal: ctrl.signal });
        const j = await r.json().catch(() => null);
        return { ok: r.ok, status: r.status, json: j };
    } catch(e) {
        return { ok: false, status: 0, error: e.message };
    } finally { clearTimeout(t); }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    console.log(C.bold('\n  ╔══════════════════════════════════════════╗'));
    console.log(C.bold('  ║   AEROSTRAT Environment Pre-flight Check ║'));
    console.log(C.bold('  ╚══════════════════════════════════════════╝'));

    // ── 1. Node.js ──────────────────────────────────────────────────────────
    section('1. Node.js / npm');
    const nodeVer = run('node -v');
    if (!nodeVer) {
        bad('Node.js not found  →  install v24+ from https://nodejs.org');
    } else {
        const major = parseInt(nodeVer.replace('v','').split('.')[0]);
        if (major >= 24) ok(`Node.js ${nodeVer}`);
        else bad(`Node.js ${nodeVer} too old — need v24+`);
    }
    const npmVer = run('npm -v');
    npmVer ? ok(`npm ${npmVer}`) : bad('npm not found');

    // ── 2. MongoDB ──────────────────────────────────────────────────────────
    section('2. MongoDB');
    try {
        const mongodbPath = path.join(BACKEND, 'node_modules', 'mongodb');
        const { MongoClient } = require(mongodbPath);
        const client = new MongoClient('mongodb://localhost:27017', { serverSelectionTimeoutMS: 3000 });
        await client.connect();
        await client.close();
        ok('MongoDB reachable at localhost:27017');
    } catch(e) {
        bad(`MongoDB connection failed  →  start MongoDB service first  (${e.message.slice(0,60)})`);
    }

    // ── 3. .env ─────────────────────────────────────────────────────────────
    section('3. Environment (.env)');
    const envPath = path.join(BACKEND, '.env');
    if (!fs.existsSync(envPath)) {
        bad('.env not found  →  create backend/.env with your API keys');
    } else {
        ok('.env exists');
        // Parse .env manually (no dotenv needed at top level)
        const envContent = fs.readFileSync(envPath, 'utf8');
        const env = {};
        envContent.split(/\r?\n/).forEach(line => {
            const m = line.match(/^([^#=]+)=(.*)$/);
            if (m) env[m[1].trim()] = m[2].trim();
        });

        const required = ['MONGODB_URI', 'PORT'];
        const missing = required.filter(k => !env[k]);
        missing.length ? bad(`Missing required vars: ${missing.join(', ')}`) : ok('Required .env vars (MONGODB, PORT) present');

        const osAccounts = [1,2,3,4,5].filter(i => env[`OPENSKY_USER${i}`] && env[`OPENSKY_PASS${i}`]);
        osAccounts.length >= 3
            ? ok(`OpenSky accounts: ${osAccounts.length} rotation accounts (USER${osAccounts.join(',USER')})`)
            : caution(`Only ${osAccounts.length} extra OpenSky accounts (OPENSKY_USER2~5)  →  no rotation on rate-limit`);
    }

    // ── 4. node_modules ─────────────────────────────────────────────────────
    section('4. npm dependencies');
    const beNM  = path.join(BACKEND, 'node_modules', 'express');
    const cliNM = path.join(CLIENT,  'node_modules', 'react');
    fs.existsSync(beNM)  ? ok('backend/node_modules installed')  : bad('backend/node_modules missing  →  run: cd backend && npm install');
    fs.existsSync(cliNM) ? ok('client/node_modules installed')   : bad('client/node_modules missing   →  run: cd client  && npm install');

    // ── 5. Ports ────────────────────────────────────────────────────────────
    section('5. Port availability');
    for (const port of [3000, 3005]) {
        const inUse = run(`netstat -an`) || '';
        if (inUse.includes(`0.0.0.0:${port} `) || inUse.includes(`:::${port} `)) {
            caution(`Port ${port} already in use (OK if service already running)`);
        } else {
            ok(`Port ${port} available`);
        }
    }

    // ── 6. MongoDB data ─────────────────────────────────────────────────────
    section('6. Database content');
    if (!fs.existsSync(path.join(BACKEND, 'node_modules', 'mongoose'))) {
        caution('Skipping DB check — backend node_modules not installed');
    } else {
        try {
            // Load .env for MONGODB_URI
            const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath,'utf8') : '';
            const envVars = {};
            envContent.split(/\r?\n/).forEach(l => { const m=l.match(/^([^#=]+)=(.*)/); if(m) envVars[m[1].trim()]=m[2].trim(); });
            const uri = envVars['MONGODB_URI'] || 'mongodb://localhost:27017/aerostrat';

            const mongoose = require(path.join(BACKEND, 'node_modules', 'mongoose'));
            await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
            const db = mongoose.connection.db;

            // Discover actual aircraft collection name (could be 'aircraft' or 'aircraftregistries')
            const colList = await db.listCollections().toArray();
            const colNames = colList.map(c => c.name);
            const aircraftCol = colNames.includes('aircraft') ? 'aircraft' : 'aircraftregistries';

            const checks = [
                { col: 'routedictionaries',   label: 'RouteDictionary',       min: 100000, fix: 'node scripts/syncOsintData.js', warnOnly: true },
                { col: 'airportdictionaries', label: 'AirportDictionary',     min: 50000,  fix: 'node scripts/syncOsintData.js', warnOnly: true },
                { col: aircraftCol,           label: 'Aircraft (Mictronics)', min: 400000, fix: 'npm run sync-mictronics', warnOnly: true },
                { col: 'aircraftshapes',      label: 'AircraftShape SVGs',    min: 100,    fix: 'npm run seed-shapes', warnOnly: true },
            ];

            for (const { col, label, min, fix, warnOnly } of checks) {
                const n = await db.collection(col).estimatedDocumentCount().catch(() => 0);
                if (n >= min) {
                    ok(`${label}: ${n.toLocaleString()} records`);
                } else if (warnOnly) {
                    caution(`${label}: only ${n.toLocaleString()} records  →  run: ${fix}`);
                } else {
                    bad(`${label}: only ${n.toLocaleString()} records  →  run: ${fix}`);
                }
            }

            // Stale sessions warning
            const stale = await db.collection('flightsessions').countDocuments({
                status: 'ACTIVE',
                updatedAt: { $lt: new Date(Date.now() - 2 * 60 * 60 * 1000) }
            }).catch(() => 0);
            if (stale > 10000) caution(`${stale.toLocaleString()} stale ACTIVE sessions in DB (auto-cleaned on startup)`);

            await mongoose.disconnect();
        } catch(e) {
            caution(`DB check skipped: ${e.message.slice(0, 60)}`);
        }
    }

    // ── 7. Static assets ────────────────────────────────────────────────────
    section('7. Static assets');
    const svgDir = path.join(BACKEND, 'public', 'svg');
    if (fs.existsSync(svgDir)) {
        const svgCount = fs.readdirSync(svgDir).filter(f => f.endsWith('.svg')).length;
        svgCount >= 100 ? ok(`Aircraft SVG icons: ${svgCount} files`) : caution(`Only ${svgCount} SVG icons found`);
    } else {
        caution('backend/public/svg/ not found');
    }

    // ── 8. External APIs ────────────────────────────────────────────────────
    section('8. External API connectivity');
    const apis = [
        { name: 'adsb.lol',         url: 'https://api.adsb.lol/v2/lat/25/lon/121/dist/50' },
        { name: 'adsb.fi',          url: 'https://opendata.adsb.fi/api/v3/lat/25/lon/121/dist/50' },
        { name: 'airplanes.live',   url: 'https://api.airplanes.live/v2/mil' },
    ];
    await Promise.all(apis.map(async ({ name, url }) => {
        const r = await fetchJSON(url);
        if (r.ok && r.status !== 429) ok(`${name} reachable (HTTP ${r.status})`);
        else caution(`${name} unreachable (${r.status || 'timeout'})  →  check network`);
    }));

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(52)}`);
    console.log(C.bold(`  Result:  ${C.green(pass + ' passed')}  ${C.yellow(warn + ' warnings')}  ${fail > 0 ? C.red(fail + ' failed') : '0 failed'}`));
    console.log('═'.repeat(52));

    if (fail > 0) {
        console.log(C.red(`\n  ✗ ${fail} issue(s) must be resolved before starting.\n`));
        process.exit(1);
    }

    if (warn > 0) console.log(C.yellow(`\n  ⚠  ${warn} warning(s) — system can still start.\n`));
    else console.log(C.green('\n  ✓ All checks passed!\n'));

    if (AUTO_START) {
        console.log('  Starting backend (port 3000)...');
        spawn('cmd', ['/c', 'start', '"AEROSTRAT Backend"', 'cmd', '/k',
            `cd /d "${BACKEND}" && npm start`], { shell: true, detached: true });
        await new Promise(r => setTimeout(r, 2000));
        console.log('  Starting frontend (port 3005)...');
        spawn('cmd', ['/c', 'start', '"AEROSTRAT Frontend"', 'cmd', '/k',
            `cd /d "${CLIENT}" && npm run dev`], { shell: true, detached: true });
        console.log(C.green('\n  System started!'));
        console.log(`  Backend:  http://localhost:3000/api/health`);
        console.log(`  Frontend: http://localhost:3005\n`);
    }
}

main().catch(e => { console.error('Check script error:', e.message); process.exit(1); });
