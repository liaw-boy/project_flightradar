'use strict';

const passport      = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const jwt           = require('jsonwebtoken');
const db            = require('../db/sqlite');

const JWT_SECRET = process.env.JWT_SECRET || 'aerostrat-secret-change-in-prod';
const TOKEN_TTL  = '30d';

// ── helpers ──────────────────────────────────────────────────────────────────

function signToken(user) {
    return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function safeUser(user) {
    const { password_hash, ...rest } = user;
    return rest;
}

/**
 * Find or create a user from an OAuth profile.
 * oauth_provider: 'google' | 'facebook'
 * oauth_id: provider's unique user ID
 */
function findOrCreateOAuthUser({ provider, providerId, displayName, email }) {
    // 1. Try to find existing OAuth link
    const existing = db.prepare(
        'SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?'
    ).get(provider, providerId);

    if (existing) return existing;

    // 2. If email exists, link to that account
    if (email) {
        const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (byEmail) {
            db.prepare('UPDATE users SET oauth_provider = ?, oauth_id = ? WHERE id = ?')
                .run(provider, providerId, byEmail.id);
            return db.prepare('SELECT * FROM users WHERE id = ?').get(byEmail.id);
        }
    }

    // 3. Create new user
    // Generate a unique username (sanitise displayName)
    let base = (displayName || 'user')
        .replace(/[^a-zA-Z0-9_]/g, '')
        .slice(0, 20) || 'user';
    let username = base;
    let suffix = 1;
    while (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        username = `${base}${suffix++}`;
    }

    const info = db.prepare(
        `INSERT INTO users (username, email, oauth_provider, oauth_id)
         VALUES (?, ?, ?, ?)`
    ).run(username, email || null, provider, providerId);

    return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

// ── Ensure DB columns exist ───────────────────────────────────────────────────

function ensureOAuthColumns() {
    const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    if (!cols.includes('oauth_provider')) {
        db.prepare('ALTER TABLE users ADD COLUMN oauth_provider TEXT').run();
    }
    if (!cols.includes('oauth_id')) {
        db.prepare('ALTER TABLE users ADD COLUMN oauth_id TEXT').run();
    }
}

ensureOAuthColumns();

// ── Passport strategies ───────────────────────────────────────────────────────

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:  process.env.APP_URL
            ? `${process.env.APP_URL}/api/auth/google/callback`
            : '/api/auth/google/callback',
    }, (accessToken, refreshToken, profile, done) => {
        try {
            const user = findOrCreateOAuthUser({
                provider:    'google',
                providerId:  profile.id,
                displayName: profile.displayName,
                email:       profile.emails?.[0]?.value,
            });
            done(null, user);
        } catch (e) {
            done(e);
        }
    }));
}

if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
    passport.use(new FacebookStrategy({
        clientID:     process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL:  process.env.APP_URL
            ? `${process.env.APP_URL}/api/auth/facebook/callback`
            : '/api/auth/facebook/callback',
        profileFields: ['id', 'displayName', 'emails'],
    }, (accessToken, refreshToken, profile, done) => {
        try {
            const user = findOrCreateOAuthUser({
                provider:    'facebook',
                providerId:  profile.id,
                displayName: profile.displayName,
                email:       profile.emails?.[0]?.value,
            });
            done(null, user);
        } catch (e) {
            done(e);
        }
    }));
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, user || false);
});

// ── Route handlers ────────────────────────────────────────────────────────────

/**
 * After OAuth success, redirect to frontend with JWT in URL hash
 * (hash is never sent to server — safer than query param)
 */
function oauthSuccess(req, res) {
    if (!req.user) return res.redirect('/?oauth_error=auth_failed');
    const token = signToken(req.user);
    const user  = JSON.stringify(safeUser(req.user));
    // Encode and redirect; frontend picks up from URL hash
    const encoded = Buffer.from(JSON.stringify({ token, user })).toString('base64url');
    res.redirect(`/?oauth_success=${encoded}`);
}

function oauthFailure(req, res) {
    res.redirect('/?oauth_error=cancelled');
}

// ── Check config ──────────────────────────────────────────────────────────────

function configStatus(req, res) {
    res.json({
        google:   !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        facebook: !!(process.env.FACEBOOK_APP_ID  && process.env.FACEBOOK_APP_SECRET),
    });
}

module.exports = { passport, oauthSuccess, oauthFailure, configStatus };
