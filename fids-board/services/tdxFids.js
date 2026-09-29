const { getAccessToken } = require("./tdxAuth");

const API_BASE = "https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Airport";

// [2026-09] No fetch in this service had a timeout — a single slow/hung TDX
// response could stall pollAirport() long enough for the next cron tick to
// fire pollOnce() again with nothing stopping it from overlapping (see
// poller.js's new _pollRunning guard). Two cycles running at once meant
// twice the request rate against TDX's stated 5/min limit, which is the
// leading theory for why this account got suspended (superuser usage
// dashboard: ~4,400 calls/day 09-01..09-03, then 0 every day since).
const REQUEST_TIMEOUT_MS = 10_000;

async function fetchFids(direction, airport = "TPE") {
  const token = await getAccessToken();
  const url = `${API_BASE}/${direction}/${airport}?$format=JSON`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TDX FIDS ${direction} 查詢失敗 (${res.status}): ${text}`);
  }
  return res.json();
}

function fetchArrival(airport = "TPE") {
  return fetchFids("Arrival", airport);
}

function fetchDeparture(airport = "TPE") {
  return fetchFids("Departure", airport);
}

module.exports = { fetchArrival, fetchDeparture };
