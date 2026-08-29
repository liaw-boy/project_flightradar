#!/usr/bin/env node
// Assembles `<repo-root>/backend-seed/` — the read-only tree that
// electron-builder's `extraResources` copies into the packaged app
// (Contents/Resources/backend-seed on macOS). Mirrors the repo-root layout
// (backend/, public-react/, client/public/favicon.svg) because
// backend/routes/staticAssets.js resolves those as siblings of backend/.
//
// Run this AFTER: `npm run build` in client/, `npm ci --omit=dev` +
// native-module rebuild in backend/, and the data prebuild step
// (backend/scripts/prebuild-electron-data.mjs).
'use strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

const OUT_DIR = path.join(REPO_ROOT, 'backend-seed');

// Dev-only / sensitive / runtime-generated files that must never ship in
// the installer image — either they don't belong in a distributable
// (secrets, the multi-GB dev SQLite file) or they get created fresh on the
// end user's machine on first launch.
const BACKEND_EXCLUDE = [
    '.env',
    'logs',
    'quota-cache.json',
    path.join('data', 'aerostrat.db'),
    path.join('data', 'aerostrat.db-wal'),
    path.join('data', 'aerostrat.db-shm'),
    path.join('data', 'sync-status.json'),
    path.join('data', 'aircraft_cache.json'),
];

function isExcludedBackendPath(relPath) {
    if (/^credentials.*\.json$/.test(relPath)) return true;
    return BACKEND_EXCLUDE.some(p => relPath === p || relPath.startsWith(p + path.sep));
}

function main() {
    const backendSrc = path.join(REPO_ROOT, 'backend');
    const publicReactSrc = path.join(REPO_ROOT, 'public-react');
    const faviconSrc = path.join(REPO_ROOT, 'client', 'public', 'favicon.svg');

    for (const [label, p] of [['backend/', backendSrc], ['public-react/', publicReactSrc]]) {
        if (!fs.existsSync(p)) {
            console.error(`[stage-backend-seed] Missing required source: ${label} (${p})`);
            console.error('[stage-backend-seed] Did you run the client build and backend data prebuild first?');
            process.exit(1);
        }
    }

    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    console.log(`[stage-backend-seed] Copying backend/ -> ${OUT_DIR}/backend/`);
    fs.cpSync(backendSrc, path.join(OUT_DIR, 'backend'), {
        recursive: true,
        filter: (source) => {
            const rel = path.relative(backendSrc, source);
            if (rel === '') return true;
            return !isExcludedBackendPath(rel);
        },
    });

    console.log(`[stage-backend-seed] Copying public-react/ -> ${OUT_DIR}/public-react/`);
    fs.cpSync(publicReactSrc, path.join(OUT_DIR, 'public-react'), { recursive: true });

    if (fs.existsSync(faviconSrc)) {
        const faviconDest = path.join(OUT_DIR, 'client', 'public', 'favicon.svg');
        fs.mkdirSync(path.dirname(faviconDest), { recursive: true });
        fs.copyFileSync(faviconSrc, faviconDest);
        console.log('[stage-backend-seed] Copied client/public/favicon.svg');
    }

    console.log('[stage-backend-seed] Done.');
}

main();
