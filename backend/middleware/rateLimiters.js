'use strict';
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// General API rate limiter
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please wait a moment.' },
    // /api/flight-details was removed from this skip-list: it fans out to 5
    // external services including a paid AeroDataBox subscription and was
    // previously exempt from ALL rate limiting — see fusionLimiter below,
    // which is now applied to it in server.js.
    skip: (req) => ['/api/events', '/api/flights/live'].some(p => req.path.startsWith(p)),
});

// Strict limiter for expensive fusion endpoints (fan out to 5 external APIs)
const fusionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many detail requests, please slow down.' },
});

// Strict limiter for lookup endpoints
const lookupLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many lookup requests.' },
});

// Monitor login rate limiter: 5 attempts / minute / IP — the /monitor
// backend can inspect internal DB/sync status, so brute force here still
// matters even though the user-account login system has been removed.
const monitorLoginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please wait a minute.' },
    keyGenerator: (req) => ipKeyGenerator(req.ip),
});

module.exports = { apiLimiter, fusionLimiter, lookupLimiter, monitorLoginLimiter };
