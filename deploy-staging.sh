#!/bin/bash
set -e

STAGING_DIR="/mnt/legend800/lbw_project/project_aerostrat-staging"

echo "=== AeroStrat Deploy (STAGING) ==="

cd "$STAGING_DIR"

echo "[1/4] Fetching + checking out latest main (detached worktree)..."
git fetch origin main
git checkout origin/main --detach

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

echo "[4/4] Restarting via systemd..."
systemctl --user restart aerostrat-staging.service

echo "=== Done ==="
systemctl --user status aerostrat-staging.service --no-pager
