#!/bin/bash

echo "🛑 Stopping all AEROSTRAT services..."

# 1. Stop Frontend (Vite)
echo "- Stopping Frontend (Vite)..."
pkill -f "vite" || echo "  (Frontend not running)"

# 2. Stop Backend (Node server.js)
echo "- Stopping Backend (Node server.js)..."
# Try both common names in case it was started from root or inside backend/
pkill -f "node backend/server.js" || pkill -f "node server.js" || echo "  (Backend not running)"

# 3. Stop potential docker containers
if [ -x "$(command -v docker-compose)" ] && [ -f "docker-compose.yml" ]; then
    echo "- Stopping Docker containers (if any)..."
    docker-compose down 2>/dev/null || true
fi

echo "✅ All services stopped."
