const { getAccessToken } = require("./tdxAuth");
const db = require("../db/init");

const API_URL = "https://tdx.transportdata.tw/api/basic/v2/Air/Airport?$format=JSON";

const upsertStmt = db.prepare(`
INSERT INTO airport_refs (airport_id, name_zh, name_en, city_zh, city_en)
VALUES (@airport_id, @name_zh, @name_en, @city_zh, @city_en)
ON CONFLICT(airport_id) DO UPDATE SET
  name_zh = excluded.name_zh,
  name_en = excluded.name_en,
  city_zh = excluded.city_zh,
  city_en = excluded.city_en
`);

const upsertMany = db.transaction((rows) => {
  for (const row of rows) upsertStmt.run(row);
});

async function syncAirportRefs() {
  const token = await getAccessToken();
  const res = await fetch(API_URL, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`TDX Airport 查詢失敗 (${res.status}): ${await res.text()}`);
  }
  const items = await res.json();
  const rows = items
    .filter((item) => item.AirportID)
    .map((item) => ({
      airport_id: item.AirportID,
      name_zh: item.AirportName && item.AirportName.Zh_tw ? item.AirportName.Zh_tw : null,
      name_en: item.AirportName && item.AirportName.En ? item.AirportName.En : null,
      city_zh: item.AirportCityName && item.AirportCityName.Zh_tw ? item.AirportCityName.Zh_tw : null,
      city_en: item.AirportCityName && item.AirportCityName.En ? item.AirportCityName.En : null,
    }));
  upsertMany(rows);
  console.log(`[airportRefSync] 同步 ${rows.length} 個機場代碼對照資料`);
  return rows.length;
}

module.exports = { syncAirportRefs };
