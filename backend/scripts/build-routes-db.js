const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROUTES_DIR = path.join(__dirname, '../data/standing-data/routes/schema-01');
const DB_PATH = path.join(__dirname, '../data/routes.db');

if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE routes (
    callsign TEXT PRIMARY KEY,
    airline_icao TEXT,
    flight_number TEXT,
    airports TEXT
  );
  CREATE INDEX idx_callsign ON routes(callsign);
`);

const insert = db.prepare(
  'INSERT OR REPLACE INTO routes (callsign, airline_icao, flight_number, airports) VALUES (?, ?, ?, ?)'
);

const insertMany = db.transaction((rows) => {
  for (const row of rows) insert.run(row);
});

let total = 0;
const csvFiles = [];

function collectCsvFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) collectCsvFiles(fullPath);
    else if (entry.name.endsWith('.csv')) csvFiles.push(fullPath);
  }
}

collectCsvFiles(ROUTES_DIR);

for (const file of csvFiles) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const rows = [];
  for (const line of lines.slice(1)) { // skip header
    const parts = line.split(',');
    if (parts.length < 5) continue;
    const [callsign, , flightNumber, airlineIcao, airports] = parts;
    if (!callsign || !airports) continue;
    rows.push([callsign.trim(), airlineIcao.trim(), flightNumber.trim(), airports.trim()]);
  }
  if (rows.length > 0) {
    insertMany(rows);
    total += rows.length;
  }
}

db.close();
console.log(`完成：共寫入 ${total} 筆航線資料 → ${DB_PATH}`);
