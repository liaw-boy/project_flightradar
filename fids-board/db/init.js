const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "flights.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS flights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  airport TEXT NOT NULL DEFAULT 'TPE',
  direction TEXT NOT NULL CHECK(direction IN ('arrival','departure')),
  flight_date TEXT NOT NULL,
  flight_number TEXT NOT NULL,
  airline_id TEXT NOT NULL,
  departure_airport TEXT NOT NULL,
  arrival_airport TEXT NOT NULL,
  scheduled_time TEXT NOT NULL,
  actual_time TEXT,
  estimated_time TEXT,
  remark TEXT,
  terminal TEXT,
  gate TEXT,
  ac_type TEXT,
  baggage_claim TEXT,
  check_counter TEXT,
  is_cargo INTEGER DEFAULT 0,
  update_time TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(airport, direction, flight_date, flight_number, scheduled_time)
);

CREATE INDEX IF NOT EXISTS idx_flights_date_dir ON flights(airport, flight_date, direction);
CREATE INDEX IF NOT EXISTS idx_flights_sched ON flights(scheduled_time);

CREATE TABLE IF NOT EXISTS airlines (
  airline_id TEXT PRIMARY KEY,
  name_zh TEXT,
  name_en TEXT
);

CREATE TABLE IF NOT EXISTS airport_refs (
  airport_id TEXT PRIMARY KEY,
  name_zh TEXT,
  name_en TEXT,
  city_zh TEXT,
  city_en TEXT
);

CREATE TABLE IF NOT EXISTS poll_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  record_count INTEGER,
  message TEXT,
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
