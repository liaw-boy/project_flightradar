#!/bin/bash
set -e

echo "=== AeroStrat Deploy ==="

cd "$(dirname "$0")"

echo "[1/4] Pulling latest code..."
git pull origin main

echo "[2/4] Building frontend..."
cd client
npm install
npm run build
npm prune --omit=dev
cd ..

echo "[3/4] Installing backend dependencies..."
cd backend
npm install --omit=dev
cd ..

echo "[4/4] Reloading PM2..."
pm2 reload aerostrat

echo "=== Done ==="
pm2 status aerostrat
