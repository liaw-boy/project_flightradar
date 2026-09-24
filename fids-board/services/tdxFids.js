const { getAccessToken } = require("./tdxAuth");

const API_BASE = "https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Airport";

async function fetchFids(direction, airport = "TPE") {
  const token = await getAccessToken();
  const url = `${API_BASE}/${direction}/${airport}?$format=JSON`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
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
