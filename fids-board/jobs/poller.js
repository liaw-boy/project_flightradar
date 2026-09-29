const cron = require("node-cron");
const { fetchArrival, fetchDeparture } = require("../services/tdxFids");
const { saveArrivals, saveDepartures, logPoll } = require("../db/flightStore");
const { AIRPORT_CODES } = require("../services/airports");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// TDX FIDS API 實測限制是每分鐘 5 次請求(見 x-ratelimit-limit-minute header)。
// 8 個機場 × 2(抵達/出發)= 16 次呼叫,所以間隔要抓 13 秒以上,一輪跑完約需 3.5 分鐘。
const REQUEST_GAP_MS = 13000;

async function pollAirport(airport) {
  try {
    const arrivals = await fetchArrival(airport);
    saveArrivals(arrivals, airport);
    logPoll(airport, "arrival", "ok", arrivals.length, null);
    console.log(`[poller] ${airport} arrival: ${arrivals.length} 筆`);
  } catch (err) {
    logPoll(airport, "arrival", "error", null, err.message);
    console.error(`[poller] ${airport} arrival 失敗:`, err.message);
  }

  await sleep(REQUEST_GAP_MS);

  try {
    const departures = await fetchDeparture(airport);
    saveDepartures(departures, airport);
    logPoll(airport, "departure", "ok", departures.length, null);
    console.log(`[poller] ${airport} departure: ${departures.length} 筆`);
  } catch (err) {
    logPoll(airport, "departure", "error", null, err.message);
    console.error(`[poller] ${airport} departure 失敗:`, err.message);
  }
}

// [2026-09] A full cycle (8 airports x 2 directions x 13s gap) takes ~3.3
// min, under the 5-min POLL_CRON interval, so cycles shouldn't overlap in
// the normal case. But nothing enforced that: every fetch() in this service
// used to have no timeout, so a single hung TDX response could stall a
// cycle well past 5 minutes, and cron.schedule() would then fire pollOnce()
// again on top of the still-running one with nothing to stop it — twice
// the request rate against TDX's 5/min limit. This guard is the second half
// of that fix (see tdxFids.js/tdxAuth.js's new REQUEST_TIMEOUT_MS): even if
// a cycle does run long, a new one is skipped rather than piled on top.
let _pollRunning = false;

async function pollOnce() {
  if (_pollRunning) {
    console.warn("[poller] previous cycle still running — skipping this tick instead of overlapping it");
    return;
  }
  _pollRunning = true;
  try {
    for (const airport of AIRPORT_CODES) {
      await pollAirport(airport);
      await sleep(REQUEST_GAP_MS);
    }
  } finally {
    _pollRunning = false;
  }
}

function startPoller() {
  const schedule = process.env.POLL_CRON || "*/2 * * * *";
  console.log(`[poller] 排程啟動: ${schedule} (機場: ${AIRPORT_CODES.join(", ")})`);
  pollOnce(); // 啟動時先跑一次,不用等第一個 cron tick
  cron.schedule(schedule, pollOnce);
}

module.exports = { startPoller, pollOnce };
