#!/bin/bash
set -e

STAGING_DIR="/mnt/legend800/lbw_project/project_aerostrat-staging"

echo "=== AeroStrat Deploy (STAGING) ==="

cd "$STAGING_DIR"

PREV_SHA=$(git rev-parse HEAD)

echo "[1/4] Fetching + checking out latest main (detached worktree)..."
git fetch origin main
git checkout origin/main --detach

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
systemctl --user restart aerostrat-staging.service

echo "=== Health check ==="
HEALTHY=0
for i in $(seq 1 10); do
    if curl -sf http://localhost:3002/api/ping > /dev/null; then
        HEALTHY=1
        break
    fi
    sleep 1
done

if [ "$HEALTHY" != "1" ]; then
    echo "!!! Health check failed after deploy — rolling back to $PREV_SHA"
    git checkout "$PREV_SHA" --detach
    cd client && npm ci && npm run build && npm prune --omit=dev && cd ..
    cd backend && npm ci --omit=dev && cd ..
    systemctl --user restart aerostrat-staging.service
    echo "=== Rolled back — staging restarted at $PREV_SHA ==="
    systemctl --user status aerostrat-staging.service --no-pager
    exit 1
fi

echo "=== Done ==="
systemctl --user status aerostrat-staging.service --no-pager
