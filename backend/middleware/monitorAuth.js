'use strict';
// ── Monitor Auth (session-based, persisted to SQLite) ──────────
// Gated purely by the /monitor password session now that the JWT
// user-account system has been removed.
const crypto = require('crypto');
const db = require('../db/sqlite');

const MONITOR_SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours

const _msInsert = db.prepare('INSERT OR REPLACE INTO monitor_sessions (token, expires_at) VALUES (?, ?)');
const _msGet    = db.prepare('SELECT expires_at FROM monitor_sessions WHERE token = ?');
const _msDel    = db.prepare('DELETE FROM monitor_sessions WHERE token = ?');
const _msClean  = db.prepare('DELETE FROM monitor_sessions WHERE expires_at < ?');

// Prune expired monitor sessions on startup
_msClean.run(Date.now());

function getMonitorToken(req) {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/(?:^|;\s*)monitor_session=([^;]+)/);
    return match ? match[1] : null;
}

function isMonitorAuthed(req) {
    const token = getMonitorToken(req);
    if (!token) return false;
    const row = _msGet.get(token);
    if (!row || Date.now() > row.expires_at) {
        if (row) _msDel.run(token);
        return false;
    }
    return true;
}

// Monitor session cookie is the only admin gate now that the JWT
// user-account system has been removed.
function isAdminAuthed(req) {
    return isMonitorAuthed(req);
}

function requireMonitorAuth(req, res, next) {
    if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

function requireAdminAccess(req, res, next) {
    if (isMonitorAuthed(req)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

function isMonitorPasswordValid(password) {
    const expected = process.env.MONITOR_PASSWORD;
    if (!expected || typeof password !== 'string') return false;
    const expectedBuf = Buffer.from(expected);
    const givenBuf = Buffer.from(password);
    // Buffers must be equal length for timingSafeEqual; pad the shorter one
    // so the comparison itself still runs in constant time either way.
    if (givenBuf.length !== expectedBuf.length) {
        crypto.timingSafeEqual(expectedBuf, Buffer.alloc(expectedBuf.length));
        return false;
    }
    return crypto.timingSafeEqual(givenBuf, expectedBuf);
}

function createMonitorSession() {
    const token = crypto.randomBytes(32).toString('hex');
    _msInsert.run(token, Date.now() + MONITOR_SESSION_TTL);
    return token;
}

function destroyMonitorSession(token) {
    if (token) _msDel.run(token);
}

function getLoginHtml(error) {
    return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<title>AEROSTRAT MONITOR — Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#171821;color:#fff;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#21222d;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,0.5)}
  .logo{text-align:center;margin-bottom:32px}
  .logo h1{font-size:20px;font-weight:700;letter-spacing:2px;color:#a9dfd8}
  .logo p{font-size:12px;color:#87888c;margin-top:4px;letter-spacing:1px}
  label{display:block;font-size:12px;font-weight:600;color:#87888c;letter-spacing:1px;margin-bottom:8px}
  input[type=password]{width:100%;background:#171821;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:14px;padding:12px 16px;outline:none;transition:border-color .2s}
  input[type=password]:focus{border-color:#a9dfd8}
  button{width:100%;margin-top:20px;background:#a9dfd8;border:none;border-radius:8px;color:#171821;font-size:14px;font-weight:700;padding:13px;cursor:pointer;transition:opacity .2s;letter-spacing:1px}
  button:hover{opacity:.85}
  .error{margin-top:16px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:10px 14px;font-size:13px;color:#f87171;text-align:center}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>AEROSTRAT</h1>
    <p>SYSTEM MONITOR</p>
  </div>
  <form method="POST" action="/monitor/login">
    <label for="pw">ADMIN PASSWORD</label>
    <input type="password" id="pw" name="password" autofocus autocomplete="current-password" placeholder="••••••••">
    <button type="submit">LOGIN</button>
    ${error ? `<div class="error">${error}</div>` : ''}
  </form>
</div>
</body>
</html>`;
}

module.exports = {
    MONITOR_SESSION_TTL,
    getMonitorToken,
    isMonitorAuthed,
    isAdminAuthed,
    requireMonitorAuth,
    requireAdminAccess,
    isMonitorPasswordValid,
    createMonitorSession,
    destroyMonitorSession,
    getLoginHtml,
};
