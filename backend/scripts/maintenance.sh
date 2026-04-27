#!/bin/bash
# AEROSTRAT Maintenance Script
# Runs: WAL checkpoint + log cleanup
# Schedule: every Sunday 02:00 via cron (eric account)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data"
LOG_DIR="$SCRIPT_DIR/../logs"
LOGFILE="$LOG_DIR/maintenance.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOGFILE"
}

log "=== AEROSTRAT Maintenance START ==="

# --- WAL Checkpoint (via Node.js better-sqlite3) ---
NODE_BIN="/home/eric/.nvm/versions/node/v20.20.1/bin/node"
BACKEND_DIR="$SCRIPT_DIR/.."

for DB in aerostrat.db routes.db; do
    DB_PATH="$DATA_DIR/$DB"
    if [ -f "$DB_PATH" ]; then
        WAL_PATH="${DB_PATH}-wal"
        WAL_SIZE_BEFORE=0
        [ -f "$WAL_PATH" ] && WAL_SIZE_BEFORE=$(du -sm "$WAL_PATH" 2>/dev/null | cut -f1 || echo 0)
        log "Checkpointing $DB (WAL before: ${WAL_SIZE_BEFORE}MB)..."
        (cd "$BACKEND_DIR" && "$NODE_BIN" -e "
const Database = require('better-sqlite3');
const db = new Database('$DB_PATH');
const r = db.pragma('wal_checkpoint(TRUNCATE)');
console.log(JSON.stringify(r));
db.close();
" 2>>"$LOGFILE") || log "WARN: checkpoint failed for $DB"
        WAL_SIZE_AFTER=0
        [ -f "$WAL_PATH" ] && WAL_SIZE_AFTER=$(du -sm "$WAL_PATH" 2>/dev/null | cut -f1 || echo 0)
        log "Checkpoint done: $DB WAL ${WAL_SIZE_BEFORE}MB -> ${WAL_SIZE_AFTER}MB"
    fi
done

# --- App Log Cleanup (keep 30 days) ---
log "Cleaning app logs older than 30 days..."
DELETED=0
while IFS= read -r -d '' f; do
    rm -f "$f"
    DELETED=$((DELETED + 1))
done < <(find "$LOG_DIR" -maxdepth 1 -name "*.log" ! -name "pm2-*.log" ! -name "maintenance.log" -mtime +30 -print0 2>/dev/null)
log "Deleted $DELETED old log file(s)"

# --- PM2 Log Rotation (truncate if > 50MB) ---
for PM2LOG in pm2-error.log pm2-out.log; do
    PM2LOG_PATH="$LOG_DIR/$PM2LOG"
    if [ -f "$PM2LOG_PATH" ]; then
        SIZE_MB=$(du -sm "$PM2LOG_PATH" 2>/dev/null | cut -f1 || echo 0)
        if [ "$SIZE_MB" -gt 50 ]; then
            # Keep last 5000 lines, discard the rest
            tail -n 5000 "$PM2LOG_PATH" > "${PM2LOG_PATH}.tmp" && mv "${PM2LOG_PATH}.tmp" "$PM2LOG_PATH"
            log "Rotated $PM2LOG (was ${SIZE_MB}MB, kept last 5000 lines)"
        else
            log "$PM2LOG is ${SIZE_MB}MB, no rotation needed"
        fi
    fi
done

# --- Disk Usage Summary ---
DB_TOTAL=$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1 || echo '?')
LOG_TOTAL=$(du -sh "$LOG_DIR" 2>/dev/null | cut -f1 || echo '?')
log "Disk usage after maintenance — data: $DB_TOTAL, logs: $LOG_TOTAL"

log "=== AEROSTRAT Maintenance DONE ==="
