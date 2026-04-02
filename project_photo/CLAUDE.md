# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspace Layout

This directory (`project_photo/`) is a workspace root inside the git repo at `/home/lbw/project_file/`. The actual project is one level up:

```
/home/lbw/project_file/
├── aerostrat/          ← main project (backend + frontend)
│   └── CLAUDE.md       ← detailed per-project guidance
└── project_photo/      ← this workspace (CWD for this session)
```

All development work happens in `../aerostrat/`. See `../aerostrat/CLAUDE.md` for full commands, architecture, and environment variable reference.

## Quick Reference

```bash
# Run both services (from ../aerostrat/)
cd ../aerostrat && npm run dev          # backend :3000 + frontend :3005

# Backend only
cd ../aerostrat/backend && npm start

# Frontend only
cd ../aerostrat/client && npm run dev

# E2E tests (requires both services running)
cd ../aerostrat/client && npx playwright test

# First-time data seeding (from ../aerostrat/backend/)
node scripts/syncOsintData.js           # airport & route CSVs
npm run seed-shapes                     # aircraft SVG shapes
npm run sync-mictronics                 # Mictronics aircraft registry
```

## Project: AEROSTRAT

Real-time global aviation surveillance system. Fuses ADS-B telemetry from OpenSky Network (5-account rotation), enriches with aircraft metadata (4-layer resolution), and streams delta-encoded updates over WebSocket (msgpack) to a React/Leaflet canvas frontend.

- **Backend**: Node.js 24+ / Express 5 / SQLite (better-sqlite3) — port **3000**
- **Frontend**: React 19 / Vite 6 / Leaflet 1.9 — port **3005** (dev)
- **Transport**: WebSocket + msgpack delta frames; HTTP polling fallback
- **Rendering**: Zero-GC TypedArray ring buffer + Path2D cache for 60fps Canvas
