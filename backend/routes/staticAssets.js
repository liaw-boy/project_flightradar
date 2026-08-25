'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const logger = require('../logger');

// [v5.0.0] Production static file serving — built frontend from public-react/
// In development, Vite dev server handles the frontend on port 3005.
// In production (Docker), serve the pre-built React app directly.
function registerFrontendStatic(app, __dirname_backend) {
    const publicReactPath = path.join(__dirname_backend, '..', 'public-react');
    if (fs.existsSync(publicReactPath)) {
        // Assets (hashed filenames) — long cache; index.html — no cache
        app.use('/assets', express.static(path.join(publicReactPath, 'assets'), { maxAge: '7d' }));
        app.use(express.static(publicReactPath, { maxAge: 0, etag: false }));
        // Express 5 wildcard syntax: serve index.html for all non-API routes (SPA fallback)
        app.get('/{*path}', (req, res, next) => {
            const p = req.path;
            if (p.startsWith('/api') || p.startsWith('/ws') || p.startsWith('/monitor')
                || p.startsWith('/airline-logos') || p.startsWith('/airline-banners')) return next();
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.sendFile(path.join(publicReactPath, 'index.html'));
        });
        logger.info('SERVER', `Serving built frontend from ${publicReactPath}`);
    }

    // Serve latest built CSS at stable path for login-layout adjuster tool
    app.get('/app.css', (req, res) => {
        try {
            const assetsDir = path.join(publicReactPath, 'assets');
            const cssFile = fs.readdirSync(assetsDir).find(f => /^index-.*\.css$/.test(f));
            if (cssFile) {
                res.setHeader('Content-Type', 'text/css');
                res.sendFile(path.join(assetsDir, cssFile));
            } else res.status(404).send('');
        } catch { res.status(404).send(''); }
    });

    // [v5.0.1] Serve favicon.svg to System Monitor and other backend routes
    app.get('/favicon.svg', (req, res) => {
        const faviconPath = path.join(__dirname_backend, '..', 'client', 'public', 'favicon.svg');
        if (fs.existsSync(faviconPath)) {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.sendFile(faviconPath);
        } else {
            res.status(404).send('Not Found');
        }
    });
}

// [v12.5] Aircraft SVG silhouettes served locally (avoids GitHub CDN 404s/rate-limits)
// Known-missing types get a generic jet silhouette instead of a 404 to suppress console noise.
function registerSvgRoutes(app, __dirname_backend) {
    app.use('/api/svg', express.static(path.join(__dirname_backend, 'public/svg'), {
        maxAge: '7d',
        fallthrough: true,
        setHeaders: (res) => { res.setHeader('Access-Control-Allow-Origin', '*'); }
    }));
    app.get('/api/svg/:typecode', (req, res) => {
        // Fallback: serve generic jet SVG for unknown typecodes — suppresses 404 noise
        const fallback = path.join(__dirname_backend, 'public/svg/A320.svg');
        if (fs.existsSync(fallback)) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.sendFile(fallback);
        } else {
            res.status(204).end(); // no content, still 2xx
        }
    });
}

// Airline logos/banners (Jxck-S/airline-logos, ICAO-named PNGs)
function registerAirlineAssetRoutes(app, __dirname_backend) {
    app.use('/airline-logos', express.static(path.join(__dirname_backend, 'public/airline-logos'), {
        maxAge: '30d',
        fallthrough: true,
        setHeaders: (res) => { res.setHeader('Access-Control-Allow-Origin', '*'); }
    }));
    app.use('/airline-banners', express.static(path.join(__dirname_backend, 'public/airline-banners'), {
        maxAge: '30d',
        fallthrough: true,
        setHeaders: (res) => { res.setHeader('Access-Control-Allow-Origin', '*'); }
    }));
    // 204 fallback for missing ICAO PNG (suppress 404 log spam)
    app.get('/airline-logos/*splat', (req, res) => res.status(204).end());
    app.get('/airline-banners/*splat', (req, res) => res.status(204).end());
}

module.exports = { registerFrontendStatic, registerSvgRoutes, registerAirlineAssetRoutes };
