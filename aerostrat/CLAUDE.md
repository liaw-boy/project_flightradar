# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AEROSTRAT is a real-time global aviation surveillance system. The backend fuses live ADS-B telemetry from multiple sources, enriches it with metadata and route inference, and streams it to a React/Leaflet frontend over WebSocket using delta encoding and MessagePack binary framing.

- **Backend**: Node.js 24+ / Express 5 / Mongoose 9 — Port **3000**
- **Frontend**: React 19 / Vite 6 / Leaflet 1.9 — Port **3005** (dev), proxies `/api` and `/ws` to port 3000
- **Database**: MongoDB local instance (`aerostrat` database)
- **Package Manager**: npm (CommonJS backend, ES modules frontend)

## Commands

```bash
# Both backend + frontend (from root)
npm run dev                      # concurrently runs backend on :3000, frontend on :3005

# Backend only
cd backend && npm start          # or root: ./start-backend.bat
# health check: http://localhost:3000/api/health

# Frontend only
cd client && npm run dev         # dev server on port 3005
cd client && npm run build       # production build → ../public-react/

# Stop all processes (Windows)
./stop-all.bat                   # kills pids on ports 3000 & 3005

# E2E tests (Playwright) — requires backend+frontend both running on :3000/:3005
cd client && npx playwright test                                 # all tests
cd client && npx playwright test tests/e2e/aerostrat.spec.js    # single file
cd client && npx playwright show-report ../pw-report            # view last report

# Data initialization (run once after fresh DB, from backend/)
node scripts/syncOsintData.js    # seeds AirportDictionary + RouteDictionary from remote CSVs
npm run seed-shapes              # seeds AircraftShape collection from local CSV
npm run sync-mictronics          # syncs AircraftRegistry from Mictronics database

# Production (PM2)
cd backend && pm2 start ecosystem.config.js   # starts as 'aerostrat' process
pm2 logs aerostrat                            # tail logs

# Docker (backend + MongoDB only; no frontend container)
docker-compose up -d             # starts mongodb + aerostrat-backend containers
```

> No unit/integration tests exist yet. Backend and frontend `package.json` test scripts are stubs.

## Environment Variables (`/backend/.env`)

```
PORT=3000
MONGODB_URI=mongodb://localhost:27017/aerostrat
OPENSKY_USER1–5 / OPENSKY_PASS1–5   # 5-account rotation pool
PRIMARY_TELEMETRY_URL               # Default: OpenSky Network
FALLBACK_TELEMETRY_URL              # Default: api.adsb.lol
AERODATABOX_API_KEY
TDX_CLIENT_ID / TDX_CLIENT_SECRET
```

OpenSky per-account credential files live at `backend/credentials1–5.json` (mounted as read-only volumes in Docker). Startup scripts validate `.env` presence and bail early if missing.

## Architecture

### End-to-End Data Flow

```
OpenSky API (30s cron, 5-account rotation)
  → backend/workers/parser.js (worker thread, off-main JSON parse)
  → MongoDB enrichment (Aircraft, Route, TrackPoint collections)
  → backend/socketEngine.js (delta encode → msgpack → WebSocket per-client bbox filter)
  → client/src/workers/flightWorker.js (off-thread decode, 33ms debounced flush)
  → React state (App.jsx) → MapView.jsx Canvas (60fps)
```

### Backend Key Files

| File | Role |
|------|------|
| `backend/server.js` | Express server, OpenSky polling, all API routes, session state machine |
| `backend/socketEngine.js` | Delta-encode plane state → msgpack → per-client spatial broadcast |
| `backend/controllers/flightController.js` | 4-layer metadata + route fusion, external API integration |
| `backend/workers/parser.js` | Worker thread: raw OpenSky arrays → lightweight plane objects |
| `backend/config.js` | dotenv loader (PORT, MONGODB_URI) |
| `backend/scripts/syncOsintData.js` | Downloads/syncs airport & route reference data |
| `backend/ecosystem.config.js` | PM2 config (single instance, 512MB cap, log to `./logs/`) |

**MongoDB collections**: Aircraft, Airport, AircraftRegistry (Mictronics reg data), AircraftShape (typecode → SVG path), Airline, AirportDictionary (OurAirports CSV), RouteDictionary (ADSB.lol routes CSV), FlightSession (ACTIVE/COMPLETED/TIMEOUT state machine), ActiveFlight, TrackPoint (TTL 24h, time-series), Route, Metar.

**API surface** (all under `/api`):
- `GET /planes/bbox` — spatial filter, <5ms
- `GET /flight-details/:hex/:cs` — fused aircraft + route
- `GET /metadata/:icao24`, `POST /metadata/batch`
- `GET /route/:icao24`, `GET /tracks`, `GET /airports/list`, `GET /metar`
- `GET /stats`, `GET /health`

### Frontend Key Files

| File | Role |
|------|------|
| `client/src/App.jsx` | State root; manages selected aircraft, filters, zoom, playback |
| `client/src/components/MapView.jsx` | Custom Leaflet Canvas layer; Path2D SVG caching, trail ring buffer, heading rotation |
| `client/src/hooks/useFlightData.js` | BBox-aware polling + WebSocket orchestration with automatic fallback |
| `client/src/hooks/useI18n.jsx` | i18n hook; language switching |
| `client/src/workers/flightWorker.js` | Off-thread WebSocket + msgpack decode; maintains consolidated plane Map; auto-reconnect with exponential backoff |
| `client/src/services/dataManager.js` | L1/L2/L3 cache facade (React state → LRU 500-entry/30min → IndexedDB) |
| `client/src/services/staticOsintCache.js` | Global insurance vault for enriched aircraft data; deduplicates API requests by icao24 prefix |
| `client/src/services/storageManager.js` | IndexedDB wrapper for L3 persistent cache |
| `client/src/store/FlightDataStore.js` | Zero-GC TypedArray ring buffer for track history (Float32Array) |
| `client/src/utils/aircraftIcons.js` | 50+ typecode SVG paths, altitude-based color mapping, zoom-responsive sizing |
| `client/src/utils/markerFactory.js` | Builds Leaflet marker instances from icon descriptors |

### Critical Design Patterns

**Delta encoding (socketEngine)**: Only planes whose lat/lng (±0.0001°) or heading (±1°) changed are included in each WebSocket frame. Removals are tracked separately.

**Zero-GC rendering**: `FlightDataStore` uses fixed-size `Float32Array` circular buffers. `MapView` caches `Path2D` objects and reuses point refs to avoid GC pressure during 60fps Canvas rendering.

**Multi-account OpenSky rotation**: Rotates across 5 accounts on 429 or quota < 50 remaining calls.

**4-layer metadata resolution** (fastest to slowest): local CSV index → MongoDB Aircraft → Tar1090 fallback → external API.

**3-tier frontend cache**: L1 React state (instant) → L2 LRU in-memory (30min TTL) → L3 IndexedDB (persistent, airports + shapes).

> [!TIP]
> Path-specific rules and custom Skills (TDD, Debugging, Webapp-Testing) are in `.claude/`.
