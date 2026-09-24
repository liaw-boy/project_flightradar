const express = require("express");
const { queryFlights, lastPollTime } = require("../db/flightStore");
const { AIRLINES } = require("../services/airlines");
const { AIRPORTS, AIRPORT_CODES } = require("../services/airports");
const db = require("../db/init");

const router = express.Router();

const BUFFER_MINUTES = 10;

function resolveAirport(req) {
  const code = (req.query.airport || "TPE").toUpperCase();
  return AIRPORT_CODES.includes(code) ? code : "TPE";
}

router.get("/airports", (req, res) => {
  res.json({ airports: AIRPORTS });
});

function todayTaipei() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
}

// 回傳「現在時間往前推 N 分鐘」的 Taipei 本地時間字串(格式與 scheduled_time 一致: YYYY-MM-DDTHH:MM)
// 用來讓儀表板預設只顯示跟當下相關的航班,而不是整天從凌晨排到晚上
function nowMinusBufferTaipei(bufferMinutes) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  const nowTaipei = new Date(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:00+08:00`
  );
  const shifted = new Date(nowTaipei.getTime() - bufferMinutes * 60 * 1000);
  return shifted.toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace(" ", "T").slice(0, 16);
}

function computeStatus(row) {
  const remark = row.remark || "";
  if (remark.includes("取消")) return "cancelled";
  if (remark.includes("延誤")) return "delayed";
  if (remark.includes("登機")) return "boarding";
  if (row.actual_time) return "done";
  // TDX 自己明確標示「準時」時,即使預計時間跟表定時間有些微差異(例如提早),也相信它是準時
  if (remark.includes("準時")) return "ontime";
  if (row.estimated_time && row.scheduled_time && row.estimated_time !== row.scheduled_time) {
    return "delayed";
  }
  return "ontime";
}

function airlineName(code) {
  const row = db.prepare("SELECT name_zh, name_en FROM airlines WHERE airline_id = ?").get(code);
  if (row && row.name_zh) return row.name_zh;
  if (row && row.name_en) return row.name_en;
  return AIRLINES[code] || code;
}

function airportCityName(code) {
  const row = db.prepare("SELECT name_zh, name_en, city_zh, city_en FROM airport_refs WHERE airport_id = ?").get(code);
  if (!row) return null;
  // 有些機場(尤其台灣本地機場)TDX 沒填城市名稱,退回用機場名稱本身
  return row.city_zh || row.city_en || row.name_zh || row.name_en || null;
}

function serialize(row) {
  return {
    flightNumber: row.flight_number,
    airlineId: row.airline_id,
    airlineName: airlineName(row.airline_id),
    origin: row.departure_airport,
    originCity: airportCityName(row.departure_airport),
    destination: row.arrival_airport,
    destinationCity: airportCityName(row.arrival_airport),
    scheduledTime: row.scheduled_time,
    estimatedTime: row.estimated_time,
    actualTime: row.actual_time,
    remark: row.remark,
    status: computeStatus(row),
    terminal: row.terminal,
    gate: row.gate,
    acType: row.ac_type,
    baggageClaim: row.baggage_claim,
    checkCounter: row.check_counter,
    updateTime: row.update_time,
  };
}

// 把「同表定時間 + 同登機門 + 同航廈 + 同路線」的多筆航班視為代碼共享(同一實體航班),
// 合併成一筆,codeshares 帶出其他已知航班號。只有 gate/terminal 都有值時才合併,
// 避免把單純「都還沒分配登機門」的不同航班誤判成同一班。
function groupCodeshares(flights) {
  const groups = new Map();
  const order = [];
  for (const f of flights) {
    const key = f.gate && f.terminal
      ? [f.scheduledTime, f.terminal, f.gate, f.origin, f.destination].join("|")
      : `__solo__${f.flightNumber}|${f.scheduledTime}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(f);
  }

  return order.map((key) => {
    const group = groups.get(key);
    if (group.length === 1) return group[0];
    // 挑資料最完整的(有機型資料)當主要顯示航班,其餘列為 codeshares
    const primary = group.slice().sort((a, b) => (b.acType ? 1 : 0) - (a.acType ? 1 : 0))[0];
    const others = group.filter((f) => f !== primary);
    return Object.assign({}, primary, {
      codeshares: others.map((f) => ({
        flightNumber: f.flightNumber,
        airlineId: f.airlineId,
        airlineName: f.airlineName,
      })),
    });
  });
}

router.get("/flights", (req, res) => {
  const airport = resolveAirport(req);
  const direction = req.query.direction === "departure" ? "departure" : "arrival";
  const today = todayTaipei();
  const date = req.query.date || today;
  const terminal = req.query.terminal || null;
  const airline = req.query.airline || null;
  const q = req.query.q || null;
  const includeCargo = req.query.cargo === "1";
  const showHistory = req.query.all === "1"; // 「查看更早航班」按鈕觸發:不隱藏已完成、不套用時間窗口
  const minTime = date === today && !showHistory ? nowMinusBufferTaipei(BUFFER_MINUTES) : null;
  const hideDone = !showHistory;

  // q 不在 SQL 層過濾,先撈全部、合併代碼共享,再依關鍵字篩選整組(避免搜到被合併掉的航班號時查無資料)
  const rows = queryFlights({ airport, direction, date, terminal, airline, q: null, minTime, includeCargo, hideDone });
  let flights = groupCodeshares(rows.map(serialize));
  if (q) {
    const needle = q.toLowerCase();
    flights = flights.filter((f) => {
      const names = [f.flightNumber, f.airlineName, f.origin, f.originCity, f.destination, f.destinationCity]
        .concat((f.codeshares || []).map((c) => c.flightNumber))
        .concat((f.codeshares || []).map((c) => c.airlineName));
      return names.filter(Boolean).some((v) => v.toLowerCase().includes(needle));
    });
  }
  res.json({
    airport,
    direction,
    date,
    lastUpdated: lastPollTime(airport),
    count: flights.length,
    flights,
  });
});

router.get("/flights/stats", (req, res) => {
  const airport = resolveAirport(req);
  const direction = req.query.direction === "departure" ? "departure" : "arrival";
  const today = todayTaipei();
  const date = req.query.date || today;
  const includeCargo = req.query.cargo === "1";
  // 統計數字永遠反映當天全貌(含已完成),不受表格的「隱藏已完成」影響
  const rows = queryFlights({ airport, direction, date, terminal: null, airline: null, q: null, minTime: null, includeCargo, hideDone: false });

  const total = rows.length;
  let delayed = 0;
  let cancelled = 0;
  let done = 0;
  for (const row of rows) {
    const status = computeStatus(row);
    if (status === "delayed") delayed++;
    else if (status === "cancelled") cancelled++;
    else if (status === "done") done++;
  }
  const onTimeRate = total ? Math.round(((total - delayed - cancelled) / total) * 100) : 0;

  res.json({ direction, date, total, onTimeRate, delayed, cancelled, done });
});

module.exports = router;
