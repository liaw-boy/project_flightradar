'use strict';
const fs = require('fs');
const path = require('path');

// Files that hold runtime state accumulated by the user — never clobbered by
// a reseed on app update, only created fresh on a true first install.
const PROTECTED_PREFIXES = [
    path.join('backend', 'data', 'aerostrat.db'),   // covers aerostrat.db, .db-wal, .db-shm
    path.join('backend', 'data', 'routes.db'),      // covers routes.db, .db-wal, .db-shm
    path.join('backend', 'data', 'sync-status.json'),
    path.join('backend', 'data', 'aircraft_cache.json'),
];

function isProtected(relPath) {
    return PROTECTED_PREFIXES.some(p => relPath === p || relPath.startsWith(p));
}

const VERSION_MARKER = '.seed-version';

/**
 * Copies the read-only backend-seed bundled inside the app into a writable
 * location under userData, on first install and again whenever the app
 * version changes. Runtime data files the user has accumulated (SQLite DBs,
 * sync-status, aircraft cache) are preserved across reseeds.
 */
function seedUserData(srcDir, destDir, appVersion, log = () => {}) {
    const markerPath = path.join(destDir, VERSION_MARKER);
    const alreadySeeded = fs.existsSync(destDir) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').trim() === appVersion;

    if (alreadySeeded) {
        log(`[seed] userData backend already at v${appVersion}, skipping copy`);
        return;
    }

    log(`[seed] seeding userData backend (v${appVersion}) from ${srcDir}`);
    fs.mkdirSync(destDir, { recursive: true });

    fs.cpSync(srcDir, destDir, {
        recursive: true,
        force: true,
        filter: (source) => {
            const rel = path.relative(srcDir, source);
            if (rel === '') return true; // root dir itself
            if (isProtected(rel) && fs.existsSync(path.join(destDir, rel))) {
                return false; // keep the existing (already-run) copy
            }
            return true;
        },
    });

    fs.writeFileSync(markerPath, appVersion, 'utf8');
    log('[seed] done');
}

module.exports = { seedUserData };
