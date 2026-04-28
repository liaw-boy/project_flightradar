'use strict';
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const db     = require('../db/sqlite');

const SALT_ROUNDS  = 10;
const TOKEN_TTL    = '7d';
const COOKIE_NAME  = 'aerostrat_token';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

// Pre-hashed dummy — equalizes login response time to prevent user-enumeration.
let DUMMY_HASH = '$2b$10$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
bcrypt.hash('__dummy_timing_equalization__', SALT_ROUNDS).then(h => { DUMMY_HASH = h; });

function getJwtSecret() {
    const s = process.env.JWT_SECRET;
    if (!s) {
        console.error('[FATAL] JWT_SECRET environment variable is not set.');
        process.exit(1);
    }
    return s;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function signToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            is_admin: user.is_admin === 1,
            is_superadmin: user.is_superadmin === 1,
        },
        getJwtSecret(),
        { expiresIn: TOKEN_TTL }
    );
}

function safeUser(user) {
    const { password_hash, ...rest } = user;
    return {
        ...rest,
        is_admin: rest.is_admin === 1,
        is_superadmin: rest.is_superadmin === 1,
    };
}

// Set the JWT as an httpOnly cookie (invisible to JS — prevents XSS token theft).
// Also returns the exp timestamp so the frontend can schedule a silent refresh
// without needing to read the cookie.
function setTokenCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge:   COOKIE_MAX_AGE,
        path:     '/',
    });
    // Decode exp for the frontend (non-secret — it's just a timestamp)
    try {
        const payload = jwt.decode(token);
        return payload?.exp ? payload.exp * 1000 : null;
    } catch { return null; }
}

function clearTokenCookie(res) {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/' });
}

// ── POST /api/auth/register ──────────────────────────────────────────────────

async function register(req, res) {
    const { username, password, email } = req.body || {};

    if (!username || !password)
        return res.status(400).json({ error: 'username and password required' });
    if (username.length < 2 || username.length > 30)
        return res.status(400).json({ error: 'username must be 2–30 characters' });
    if (password.length < 6)
        return res.status(400).json({ error: 'password must be at least 6 characters' });

    try {
        const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (exists) return res.status(409).json({ error: 'username already taken' });

        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        const info = db.prepare(
            'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)'
        ).run(username, email || null, hash);

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
        const token = signToken(user);
        const tokenExpiry = setTokenCookie(res, token);
        res.status(201).json({ user: safeUser(user), tokenExpiry });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

// ── POST /api/auth/login ─────────────────────────────────────────────────────

async function login(req, res) {
    const { uid, username: bodyUsername, password } = req.body || {};
    const username = uid || bodyUsername;
    if (!username || !password)
        return res.status(400).json({ error: 'username and password required' });

    try {
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user) {
            await bcrypt.compare(password, DUMMY_HASH);
            return res.status(401).json({ error: 'invalid credentials' });
        }

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'invalid credentials' });

        const token = signToken(user);
        const tokenExpiry = setTokenCookie(res, token);
        res.json({ user: safeUser(user), tokenExpiry });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

// ── GET /api/auth/me ─────────────────────────────────────────────────────────

function me(req, res) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json({ user: safeUser(user) });
}

// ── POST /api/auth/logout ────────────────────────────────────────────────────

function logout(req, res) {
    clearTokenCookie(res);
    res.json({ ok: true });
}

// ── middleware ───────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
    // Accept token from httpOnly cookie (preferred) or Authorization header (legacy / API clients)
    const cookieToken = req.cookies?.[COOKIE_NAME];
    const headerValue = req.headers.authorization || '';
    const headerToken = headerValue.startsWith('Bearer ') ? headerValue.slice(7) : null;
    const token = cookieToken || headerToken;

    if (!token) return res.status(401).json({ error: 'authentication required' });

    try {
        req.user = jwt.verify(token, getJwtSecret());
        next();
    } catch {
        res.status(401).json({ error: 'invalid or expired token' });
    }
}

function adminMiddleware(req, res, next) {
    if (!req.user?.is_admin) return res.status(403).json({ error: 'admin required' });
    next();
}

function superAdminMiddleware(req, res, next) {
    if (!req.user?.is_superadmin) return res.status(403).json({ error: 'superadmin required' });
    next();
}

// ── POST /api/auth/refresh ───────────────────────────────────────────────────
// Re-issues a fresh 7-day JWT. Called by the frontend when token has < 3 days left.
async function refresh(req, res) {
    const cookieToken = req.cookies?.[COOKIE_NAME];
    const headerValue = req.headers.authorization || '';
    const headerToken = headerValue.startsWith('Bearer ') ? headerValue.slice(7) : null;
    const token = cookieToken || headerToken;

    if (!token) return res.status(401).json({ error: 'no token' });
    try {
        const payload = jwt.verify(token, getJwtSecret());
        const user    = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
        if (!user) return res.status(401).json({ error: 'user not found' });
        const newToken = signToken(user);
        const tokenExpiry = setTokenCookie(res, newToken);
        return res.json({ user: safeUser(user), tokenExpiry });
    } catch {
        return res.status(401).json({ error: 'invalid or expired token' });
    }
}

module.exports = { register, login, me, logout, refresh, authMiddleware, adminMiddleware, superAdminMiddleware };
