'use strict';
/**
 * syncLogger.js — Persistent sync-job status tracker.
 *
 * Each job entry:
 *   { status, lastRun, lastSuccess, lastFailure, error, consecutiveFails }
 *
 * Writes to data/sync-status.json on every update.
 * Appends to logs/sync-errors.log on every failure.
 */
const fs   = require('fs');
const path = require('path');

const STATUS_FILE    = path.join(__dirname, '..', 'data', 'sync-status.json');
const ERROR_LOG_FILE = path.join(__dirname, '..', 'logs', 'sync-errors.log');

// Ensure logs dir exists
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ── In-memory state ──────────────────────────────────────────────────────────
const state = {};

// ── Load persisted state on startup ─────────────────────────────────────────
(function load() {
    try {
        if (fs.existsSync(STATUS_FILE)) {
            const saved = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
            Object.assign(state, saved);
        }
    } catch (_) {}
})();

function persist() {
    try {
        const dir = path.dirname(STATUS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATUS_FILE, JSON.stringify(state, null, 2));
    } catch (_) {}
}

function appendErrorLog(job, message) {
    try {
        const ts   = new Date().toISOString();
        const line = `[${ts}] [${job}] ${message}\n`;
        fs.appendFileSync(ERROR_LOG_FILE, line);
    } catch (_) {}
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Call when a sync job starts. */
function start(job) {
    if (!state[job]) state[job] = { status: 'unknown', lastRun: null, lastSuccess: null, lastFailure: null, error: null, consecutiveFails: 0 };
    state[job].status  = 'syncing';
    state[job].lastRun = new Date().toISOString();
    persist();
}

/** Call when a sync job succeeds. */
function success(job, detail = '') {
    if (!state[job]) state[job] = { consecutiveFails: 0 };
    state[job].status           = 'ok';
    state[job].lastRun          = state[job].lastRun || new Date().toISOString();
    state[job].lastSuccess      = new Date().toISOString();
    state[job].error            = null;
    state[job].consecutiveFails = 0;
    if (detail) state[job].detail = detail;
    persist();
}

/** Call when a sync job fails. */
function fail(job, errorMessage) {
    if (!state[job]) state[job] = { consecutiveFails: 0 };
    state[job].status           = 'error';
    state[job].lastRun          = state[job].lastRun || new Date().toISOString();
    state[job].lastFailure      = new Date().toISOString();
    state[job].error            = errorMessage;
    state[job].consecutiveFails = (state[job].consecutiveFails || 0) + 1;
    persist();
    appendErrorLog(job, errorMessage);
}

/** Return snapshot of all job statuses. */
function getAll() {
    return { ...state };
}

/** Return status for a single job. */
function get(job) {
    return state[job] || null;
}

module.exports = { start, success, fail, getAll, get };
