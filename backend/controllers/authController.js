'use strict';
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const db     = require('../db/sqlite');

const SALT_ROUNDS = 10;
const TOKEN_TTL   = '7d';   // reduced from 30d

function getJwtSecret() {
    const s = process.env.JWT_SECRET;
    if (!s) {
        console.error('[FATAL] JWT_SECRET environment variable is not set.');
        process.exit(1);
    }
    return s;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function signToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, is_admin: user.is_admin === 1 },
        getJwtSecret(),
        { expiresIn: TOKEN_TTL }
    );
}

function safeUser(user) {
    const { password_hash, ...rest } = user;
    return { ...rest, is_admin: rest.is_admin === 1 };
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
        res.status(201).json({ token: signToken(user), user: safeUser(user) });
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
        if (!user) return res.status(401).json({ error: 'invalid credentials' });

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'invalid credentials' });

        res.json({ token: signToken(user), user: safeUser(user) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

// ── GET /api/auth/me ─────────────────────────────────────────────────────────

function me(req, res) {
    // req.user injected by authMiddleware
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json({ user: safeUser(user) });
}

// ── middleware ───────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
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

module.exports = { register, login, me, authMiddleware, adminMiddleware };
