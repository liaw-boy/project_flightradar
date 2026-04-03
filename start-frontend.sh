#!/bin/bash

echo -e "\033]0;AEROSTRAT Frontend (Port 3005)\007"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/client" || exit 1

echo
echo " =========================================="
echo " AEROSTRAT Frontend UI v5.0.0"
echo " Port 3005  /  Proxy to localhost:3001"
echo " =========================================="
echo

if [ ! -d "node_modules" ]; then
    echo " [SETUP] Installing dependencies..."
    npm install || exit 1
    echo
fi

echo " [INFO] Open browser: http://localhost:3005"
echo " [INFO] Make sure backend is running first!"
echo " [INFO] Press Ctrl+C to stop frontend only"
echo

npm run dev

echo
echo " Frontend stopped. Backend is still running."
read -p "Press Enter to continue..."
