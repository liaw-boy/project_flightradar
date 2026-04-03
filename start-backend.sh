#!/bin/bash
set -e

echo -e "\033]0;AEROSTRAT Backend (Port 3000)\007"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# cd "$SCRIPT_DIR/backend" (Now running from root)

echo
echo " =========================================="
echo " AEROSTRAT Backend Engine v5.0.0"
echo " Port 3001  /  MongoDB Local"
echo " =========================================="
echo

if [ ! -f ".env" ]; then
    echo " [ERROR] .env not found!"
    echo " Please create .env with MONGODB_URI, PORT, OPENSKY credentials."
    echo
    read -p "Press Enter to exit..."
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo " [SETUP] Installing dependencies..."
    npm install
    echo
fi

echo " [INFO] Health check: http://localhost:3001/api/health"
echo " [INFO] Press Ctrl+C to stop backend"
echo

PORT="${PORT:-3001}" node server.js

echo
echo " Backend stopped."
read -p "Press Enter to continue..."
