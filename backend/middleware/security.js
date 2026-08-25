'use strict';
const cors = require('cors');
const helmet = require('helmet');

const _allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:3005')
    .split(',').map(s => s.trim()).filter(Boolean);

const corsMiddleware = cors({
    origin: (origin, cb) => {
        // Allow same-origin requests (no Origin header) and whitelisted origins
        if (!origin || _allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
});

// img-src includes map tile providers (CartoCD, ArcGIS, OpenTopoMap) + Planespotters CDN for aircraft photos.
// script-src keeps 'unsafe-inline' because Vite injects module-preload inline scripts at build time.
// connect-src 'self' covers same-origin XHR, fetch, SSE, and WebSocket (ws/wss same-origin).
// [Photo Fix] airport-data.com was missing here even though /api/photos/:icao24's
// fallback chain (and adsbdb's url_photo, wired in as a further fallback in
// flightController.js) both return airport-data.com image URLs. The backend was
// successfully fetching and returning those URLs, but the browser silently
// blocked every <img src> pointed at them — no network request, no onload, no
// error surfaced to the app — so the sidebar just sat on its loading/placeholder
// state forever for any aircraft whose only hit came from that source.
const helmetMiddleware = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:            ["'self'"],
            scriptSrc:             ["'self'", "'unsafe-inline'"],
            styleSrc:              ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc:               ["'self'", "https://fonts.gstatic.com"],
            imgSrc:                ["'self'", "data:", "blob:",
                                    "https://*.cartocdn.com",
                                    "https://server.arcgisonline.com",
                                    "https://tile.opentopomap.org",
                                    "https://*.planespotters.net",
                                    // Planespotters serves its actual photo images from a
                                    // completely different domain than its API host — not a
                                    // subdomain of planespotters.net, so the entry above never
                                    // covered it. Every real photo the API successfully found
                                    // was silently dropped by the browser's own CSP enforcement.
                                    "https://*.plnspttrs.net",
                                    "https://airport-data.com"],
            connectSrc:            ["'self'"],
            workerSrc:             ["'self'", "blob:"],
            frameSrc:              ["'none'"],
            objectSrc:             ["'none'"],
            baseUri:               ["'self'"],
        },
    },
    crossOriginEmbedderPolicy: false, // Needed for Leaflet tile img cross-origin
    // The /api/svg, /airline-logos, /airline-banners routes below explicitly
    // set Access-Control-Allow-Origin: * for cross-origin embedding — helmet's
    // default Cross-Origin-Resource-Policy: same-origin would silently block
    // that regardless of the ACAO header (CORP is enforced independently by
    // the browser), so it's relaxed globally to match that existing intent.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
});

module.exports = { corsMiddleware, helmetMiddleware };
