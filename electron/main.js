'use strict';
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const { fork } = require('child_process');

const { findFreePort } = require('./util/findFreePort');
const { seedUserData } = require('./util/seedUserData');
const { buildMenu } = require('./menu');

const isDev = !app.isPackaged;
const DEV_FRONTEND_URL = 'http://localhost:3005';

let mainWindow = null;
let serverProcess = null;
let serverExited = Promise.resolve();

// ── Single instance lock ──────────────────────────────────────────────────
// Two processes must never open the same WAL-mode SQLite file concurrently
// (see docs/deploy.md) — refuse a second launch, focus the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

function log(...args) {
    console.log('[electron/main]', ...args);
}

async function startBackend() {
    if (isDev) {
        // In dev, `npm run dev:electron` already starts backend (port 3000)
        // and the Vite dev server (port 3005) via `concurrently` + `wait-on`.
        // Electron just wraps the live dev URL — no fork, no seeding.
        return { url: DEV_FRONTEND_URL };
    }

    // backend-seed/ mirrors the repo root layout (backend/, public-react/,
    // client/public/favicon.svg) because staticAssets.js resolves
    // public-react and the favicon as siblings of backend/, not inside it.
    const backendSeedDir = path.join(process.resourcesPath, 'backend-seed');
    const runtimeDir = path.join(app.getPath('userData'), 'runtime');
    const userDataBackendDir = path.join(runtimeDir, 'backend');

    seedUserData(backendSeedDir, runtimeDir, app.getVersion(), log);

    const port = await findFreePort();
    const serverEntry = path.join(userDataBackendDir, 'server.js');

    const env = {
        ...process.env,
        PORT: String(port),
        AEROSTRAT_DB_PATH: path.join(userDataBackendDir, 'data', 'aerostrat.db'),
        ELECTRON_RUN_AS_NODE: '1',
    };

    serverProcess = fork(serverEntry, [], {
        cwd: userDataBackendDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    serverProcess.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
    serverProcess.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));

    serverExited = new Promise((resolve) => {
        serverProcess.once('exit', (code, signal) => {
            log(`backend exited (code=${code} signal=${signal})`);
            serverProcess = null;
            resolve();
        });
    });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Backend did not signal readiness within 20s'));
        }, 20000);

        serverProcess.once('message', (msg) => {
            if (msg && msg.type === 'ready') {
                clearTimeout(timeout);
                resolve();
            }
        });

        serverProcess.once('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    return { url: `http://127.0.0.1:${port}` };
}

function stopBackend() {
    if (!serverProcess) return serverExited;

    serverProcess.kill('SIGTERM');
    const killTimer = setTimeout(() => {
        if (serverProcess) serverProcess.kill('SIGKILL');
    }, 5000);

    return serverExited.then(() => clearTimeout(killTimer));
}

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 640,
        title: 'AeroStrat',
        backgroundColor: '#0b0f14',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        show: false,
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });

    try {
        const { url } = await startBackend();
        await mainWindow.loadURL(url);
    } catch (err) {
        log('Failed to start backend:', err);
        await mainWindow.loadURL(
            `data:text/html,<h1>AeroStrat failed to start</h1><pre>${encodeURIComponent(String(err.stack || err))}</pre>`
        );
    }
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// macOS convention: closing the last window doesn't quit the app or kill
// the backend — only an actual Cmd+Q (before-quit) does that.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
    if (quitting || isDev) return;
    quitting = true;
    event.preventDefault();
    stopBackend().finally(() => app.quit());
});
