// 一次性檢查工具:印出 ODPT 羽田(ANA)實際回傳的原始 JSON 欄位,
// 用來校正 odptFids.js 之後要接到 db/flightStore.js 的欄位對照表。
// 用法: ODPT_CONSUMER_KEY=xxx node scripts/odpt-inspect.js
require("dotenv").config();
const { fetchArrival, fetchDeparture } = require("../services/odptFids");

async function main() {
  const arrivals = await fetchArrival("ANA");
  console.log(`\n=== ANA 抵達 raw 筆數: ${arrivals.length} ===`);
  console.log(JSON.stringify(arrivals[0], null, 2));

  await new Promise((r) => setTimeout(r, 2000));

  const departures = await fetchDeparture("ANA");
  console.log(`\n=== ANA 出發 raw 筆數: ${departures.length} ===`);
  console.log(JSON.stringify(departures[0], null, 2));
}

main().catch((err) => {
  console.error("檢查失敗:", err.message);
  process.exit(1);
});
