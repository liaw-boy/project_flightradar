# CLAUDE.md - AEROSTRAT Project Configuration

## ✈️ Project Overview
AEROSTRAT is a professional-grade global aviation surveillance system with a decoupled architecture. 
- **Backend**: Node.js + MongoDB + WebSocket engine (Port 3000).
- **Frontend**: React (Vite) + Leaflet Canvas engine (Port 5173).

## 🛠 Tech Stack
- **Frontend**: React 19, Vite 6, Leaflet 1.9, Lucide React, msgpack-lite.
- **Backend**: Node.js 24+, Express 5, Mongoose 9, node-cron, ws, helmet.
- **Database**: MongoDB (Local).
- **Package Manager**: npm.

## 📂 Project Structure
- `/backend`: API & Data Fusion Engine.
- `/client`: Frontend UI (Vite project).
- Root: OS-level startup scripts (`.bat`).

## 🚀 Execution Commands
- **Start Backend**: `npm start` (inside `/backend`) or root `./start-backend.bat`.
- **Start Frontend**: `npm run dev` (inside `/client`) or root `./start-frontend.bat`.
- **Stop All**: root `./stop-all.bat`.

## ⚙️ Environment Variables (Required in `/backend/.env`)
- `OPENSKY_USER[1-5]`, `OPENSKY_PASS[1-5]`
- `MONGODB_URI`
- `PORT`
- `AERODATABOX_API_KEY`
- `TDX_CLIENT_ID`, `TDX_CLIENT_SECRET`

## 🎨 Coding Standards
- **Style**: Functional components in React, CommonJS for backend.
- **Icons**: Use `client/src/utils/aircraftIcons.js` for SVG path dictionary.
- **Rotation**: Aircraft icons are North-Up (0°). Use `rotationOffset` in `MapView.jsx` for calibration.
- **Commits**: Use descriptive messages or Conventional Commits.

## ⚠️ Known Issues / Architecture Notes
- **Decoupled Proxy**: Vite proxies `/api` and `/ws` to `localhost:3000`.
- **Memory Pressure**: High plane count (5000+) uses Canvas `ImageBitmap` caching.
- **Data Persistence**: MongoDB TTL is 48 hours for history tracks.
