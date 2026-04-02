/**
 * AEROSTRAT Frontend Logger
 * - Category-based colorized console output with timestamps
 * - logToServer: forwards important events to backend terminal
 * - logger.{info|warn|error|debug}(category, message, data?)
 *
 * Usage:
 *   import { logger, logToServer } from '../utils/logger';
 *   logger.info('WS', 'WebSocket connected');
 *   logger.warn('FETCH', 'Retrying after error', { attempt: 2 });
 *   logToServer('User selected aircraft', 'info', { icao: 'abc123' });
 */

const CATEGORY_STYLES = {
    WS:    'color:#9C27B0;font-weight:bold',  // purple
    FETCH: 'color:#2196F3;font-weight:bold',  // blue
    DATA:  'color:#00BCD4;font-weight:bold',  // teal
    CACHE: 'color:#FF9800;font-weight:bold',  // orange
    INIT:  'color:#4CAF50;font-weight:bold',  // green
    UI:    'color:#607D8B;font-weight:bold',  // grey
};

const LEVEL_STYLES = {
    info:  'color:#4CAF50;font-weight:bold',
    warn:  'color:#FF9800;font-weight:bold',
    error: 'color:#F44336;font-weight:bold',
    debug: 'color:#90A4AE',
};

function ts() {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function print(level, category, message, data) {
    const style = CATEGORY_STYLES[category.toUpperCase()] || LEVEL_STYLES[level] || LEVEL_STYLES.info;
    const prefix = `[${ts()}][${category.toUpperCase()}]`;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (data !== undefined) {
        fn(`%c${prefix} ${message}`, style, data);
    } else {
        fn(`%c${prefix} ${message}`, style);
    }
}

export const logger = {
    info:  (cat, msg, data) => print('info',  cat, msg, data),
    warn:  (cat, msg, data) => print('warn',  cat, msg, data),
    error: (cat, msg, data) => print('error', cat, msg, data),
    debug: (cat, msg, data) => print('debug', cat, msg, data),
};

/**
 * 傳送前端操作或錯誤至後端 terminal 顯示。
 * 同時會在瀏覽器 console 輸出一份彩色記錄。
 */
export const logToServer = async (message, type = 'info', data = {}) => {
    const hasData = data && Object.keys(data).length > 0;
    print(type, 'SERVER', message, hasData ? data : undefined);

    try {
        await fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, type, data })
        });
    } catch (_) {
        // Ignore logging errors to prevent loops
    }
};
