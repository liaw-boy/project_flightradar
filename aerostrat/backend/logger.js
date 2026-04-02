/**
 * AEROSTRAT Backend Logger
 * - Log levels: DEBUG, INFO, WARN, ERROR
 * - Colorized console output with timestamps
 * - Daily rolling file: backend/logs/YYYY-MM-DD.log
 * - Controlled by LOG_LEVEL env var (default: INFO)
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const LEVEL_RANK = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CONSOLE_COLORS = {
    DEBUG: '\x1b[36m',  // cyan
    INFO:  '\x1b[32m',  // green
    WARN:  '\x1b[33m',  // yellow
    ERROR: '\x1b[31m',  // red
    RESET: '\x1b[0m'
};

const MIN_LEVEL = LEVEL_RANK[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVEL_RANK.INFO;

function getTimestamp() {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function getTodayLogPath() {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(LOG_DIR, `${date}.log`);
}

function buildLine(level, module, message, data) {
    const ts = getTimestamp();
    const dataStr = (data !== undefined && data !== null) ? ` | ${JSON.stringify(data)}` : '';
    return `[${ts}] [${level.padEnd(5)}] [${module}] ${message}${dataStr}`;
}

function write(level, module, message, data) {
    if (LEVEL_RANK[level] < MIN_LEVEL) return;

    const line = buildLine(level, module, message, data);
    const color = CONSOLE_COLORS[level] || '';

    // Console output (colorized)
    if (level === 'ERROR') console.error(`${color}${line}${CONSOLE_COLORS.RESET}`);
    else if (level === 'WARN')  console.warn(`${color}${line}${CONSOLE_COLORS.RESET}`);
    else                        console.log(`${color}${line}${CONSOLE_COLORS.RESET}`);

    // File output (plain)
    try {
        fs.appendFileSync(getTodayLogPath(), line + '\n');
    } catch (_) {
        // Do not throw on file write error
    }
}

module.exports = {
    debug: (mod, msg, data) => write('DEBUG', mod, msg, data),
    info:  (mod, msg, data) => write('INFO',  mod, msg, data),
    warn:  (mod, msg, data) => write('WARN',  mod, msg, data),
    error: (mod, msg, data) => write('ERROR', mod, msg, data),
    /** HTTP request logger middleware for Express */
    httpMiddleware: (req, res, next) => {
        const start = Date.now();
        const { method, path: reqPath, ip } = req;
        res.on('finish', () => {
            const ms = Date.now() - start;
            const status = res.statusCode;
            // Skip high-frequency endpoints to reduce noise
            if (['/api/events', '/api/viewport', '/api/planes/bbox-ping'].includes(reqPath)) return;
            if (status >= 500)      write('ERROR', 'HTTP', `${method} ${reqPath} → ${status} (${ms}ms) [${ip}]`);
            else if (status >= 400) write('WARN',  'HTTP', `${method} ${reqPath} → ${status} (${ms}ms) [${ip}]`);
            else                    write('DEBUG', 'HTTP', `${method} ${reqPath} → ${status} (${ms}ms)`);
        });
        next();
    }
};
