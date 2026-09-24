const { getAccessToken } = require("./tdxAuth");
const db = require("../db/init");

const API_URL = "https://tdx.transportdata.tw/api/basic/v2/Air/Airline?$format=JSON";

const upsertStmt = db.prepare(`
INSERT INTO airlines (airline_id, name_zh, name_en)
VALUES (@airline_id, @name_zh, @name_en)
ON CONFLICT(airline_id) DO UPDATE SET
  name_zh = excluded.name_zh,
  name_en = excluded.name_en
`);

const upsertMany = db.transaction((rows) => {
  for (const row of rows) upsertStmt.run(row);
});

async function syncAirlines() {
  const token = await getAccessToken();
  const res = await fetch(API_URL, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`TDX Airline 查詢失敗 (${res.status}): ${await res.text()}`);
  }
  const items = await res.json();
  const rows = items
    .filter((item) => item.AirlineID)
    .map((item) => ({
      airline_id: item.AirlineID,
      name_zh: item.AirlineName && item.AirlineName.Zh_tw ? item.AirlineName.Zh_tw : null,
      name_en: item.AirlineName && item.AirlineName.En ? item.AirlineName.En : null,
    }));
  upsertMany(rows);
  console.log(`[airlineSync] 同步 ${rows.length} 家航空公司資料`);
  return rows.length;
}

module.exports = { syncAirlines };
