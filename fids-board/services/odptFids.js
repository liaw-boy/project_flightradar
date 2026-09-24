// 羽田機場即時起降資訊(ODPT 公共交通オープンデータセンター)
// 跟 TDX 不同,ODPT 不是「查機場」而是「查航空公司/航廈營運方」,
// 羽田要涵蓋所有航班得分別查 ANA、JAL、TIAT(東京国際空港ターミナル,國際線)三個 operator。
const ODPT_BASE = "https://api.odpt.org/api/v4";

const HND_OPERATORS = ["ANA", "JAL", "TIAT"];

function consumerKey() {
  const key = process.env.ODPT_CONSUMER_KEY;
  if (!key) throw new Error("ODPT_CONSUMER_KEY 未設定");
  return key;
}

async function fetchByOperator(className, operator) {
  const url = `${ODPT_BASE}/${className}?odpt:operator=odpt.Operator:${operator}&acl:consumerKey=${consumerKey()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ODPT ${className} (${operator}) 查詢失敗 (${res.status}): ${text}`);
  }
  return res.json();
}

function fetchArrival(operator) {
  return fetchByOperator("odpt:FlightInformationArrival", operator);
}

function fetchDeparture(operator) {
  return fetchByOperator("odpt:FlightInformationDeparture", operator);
}

// 依序查完羽田三個 operator 的抵達/出發資料並攤平成單一陣列。
// 呼叫端(poller)要負責在多次呼叫之間加延遲,避免觸發速率限制(實際限制待註冊後於 response header 確認)。
async function fetchAllArrivals(sleepMs, sleep) {
  const results = [];
  for (const operator of HND_OPERATORS) {
    results.push(...(await fetchArrival(operator)));
    if (sleep) await sleep(sleepMs);
  }
  return results;
}

async function fetchAllDepartures(sleepMs, sleep) {
  const results = [];
  for (const operator of HND_OPERATORS) {
    results.push(...(await fetchDeparture(operator)));
    if (sleep) await sleep(sleepMs);
  }
  return results;
}

module.exports = {
  HND_OPERATORS,
  fetchArrival,
  fetchDeparture,
  fetchAllArrivals,
  fetchAllDepartures,
};
