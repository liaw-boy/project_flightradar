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

async function pollOnce() {
  for (const airport of AIRPORT_CODES) {
    await pollAirport(airport);
    await sleep(REQUEST_GAP_MS);
  }
}

function startPoller() {
  const schedule = process.env.POLL_CRON || "*/2 * * * *";
  console.log(`[poller] 排程啟動: ${schedule} (機場: ${AIRPORT_CODES.join(", ")})`);
  pollOnce(); // 啟動時先跑一次,不用等第一個 cron tick
  cron.schedule(schedule, pollOnce);
}

module.exports = { startPoller, pollOnce };
