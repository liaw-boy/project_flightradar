#!/bin/bash
set -e

echo "=== AeroStrat Deploy ==="

cd "$(dirname "$0")"

PREV_SHA=$(git rev-parse HEAD)

echo "[1/4] Pulling latest code..."
git pull origin main

echo "[2/4] Building frontend..."
cd client
npm ci
npm run build
npm prune --omit=dev
cd ..

echo "[3/4] Installing backend dependencies..."
cd backend
npm ci --omit=dev
cd ..

echo "[4/4] Restarting via systemd..."
systemctl --user restart aerostrat.service

echo "=== Health check ==="
HEALTHY=0
for i in $(seq 1 10); do
    if curl -sf http://localhost:3000/api/ping > /dev/null; then
        HEALTHY=1
        break
    fi
    sleep 1
done

if [ "$HEALTHY" != "1" ]; then
    echo "!!! Health check failed after deploy — rolling back to $PREV_SHA"
    git reset --hard "$PREV_SHA"
    cd client && npm ci && npm run build && npm prune --omit=dev && cd ..
    cd backend && npm ci --omit=dev && cd ..
    systemctl --user restart aerostrat.service
    echo "=== Rolled back — service restarted at $PREV_SHA ==="
    systemctl --user status aerostrat.service --no-pager
    exit 1
fi

echo "=== Done ==="
systemctl --user status aerostrat.service --no-pager
