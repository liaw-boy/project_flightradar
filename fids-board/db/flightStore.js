const db = require("./init");

// TDX 對於「無資料」欄位有時給空字串,有時給純破折號("-"),統一正規化成 null
function clean(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === "-" || trimmed === "--") return null;
  return trimmed;
}

const upsertStmt = db.prepare(`
INSERT INTO flights (
  airport, direction, flight_date, flight_number, airline_id,
  departure_airport, arrival_airport,
  scheduled_time, actual_time, estimated_time, remark,
  terminal, gate, ac_type, baggage_claim, check_counter,
  is_cargo, update_time
) VALUES (
  @airport, @direction, @flight_date, @flight_number, @airline_id,
  @departure_airport, @arrival_airport,
  @scheduled_time, @actual_time, @estimated_time, @remark,
  @terminal, @gate, @ac_type, @baggage_claim, @check_counter,
  @is_cargo, @update_time
)
ON CONFLICT(airport, direction, flight_date, flight_number, scheduled_time)
DO UPDATE SET
  actual_time = excluded.actual_time,
  estimated_time = excluded.estimated_time,
  remark = excluded.remark,
  terminal = excluded.terminal,
  gate = excluded.gate,
  ac_type = excluded.ac_type,
  baggage_claim = excluded.baggage_claim,
  check_counter = excluded.check_counter,
  update_time = excluded.update_time,
  fetched_at = datetime('now')
`);

function toArrivalRow(item, airport) {
  return {
    airport,
    direction: "arrival",
    flight_date: item.FlightDate,
    flight_number: item.AirlineID + item.FlightNumber,
    airline_id: item.AirlineID,
    departure_airport: item.DepartureAirportID,
    arrival_airport: item.ArrivalAirportID,
    scheduled_time: item.ScheduleArrivalTime || null,
    actual_time: item.ActualArrivalTime || null,
    estimated_time: item.EstimatedArrivalTime || null,
    remark: clean(item.ArrivalRemark),
    terminal: clean(item.Terminal),
    gate: clean(item.Gate),
    ac_type: clean(item.AcType),
    baggage_claim: clean(item.BaggageClaim),
    check_counter: null,
    is_cargo: item.IsCargo ? 1 : 0,
    update_time: item.UpdateTime,
  };
}

function toDepartureRow(item, airport) {
  return {
    airport,
    direction: "departure",
    flight_date: item.FlightDate,
    flight_number: item.AirlineID + item.FlightNumber,
    airline_id: item.AirlineID,
    departure_airport: item.DepartureAirportID,
    arrival_airport: item.ArrivalAirportID,
    scheduled_time: item.ScheduleDepartureTime || null,
    actual_time: item.ActualDepartureTime || null,
    estimated_time: item.EstimatedDepartureTime || null,
    remark: clean(item.DepartureRemark),
    terminal: clean(item.Terminal),
    gate: clean(item.Gate),
    ac_type: clean(item.AcType),
    baggage_claim: null,
    check_counter: clean(item.CheckCounter),
    is_cargo: item.IsCargo ? 1 : 0,
    update_time: item.UpdateTime,
  };
}

const upsertMany = db.transaction((rows) => {
  for (const row of rows) {
    if (!row.scheduled_time) continue; // TDX 偶爾回傳缺表定時間的殘缺列,略過
    upsertStmt.run(row);
  }
});

function saveArrivals(items, airport) {
  upsertMany(items.map((item) => toArrivalRow(item, airport)));
}

function saveDepartures(items, airport) {
  upsertMany(items.map((item) => toDepartureRow(item, airport)));
}

function queryFlights({ airport, direction, date, terminal, airline, q, minTime, includeCargo, hideDone }) {
  let sql = "SELECT * FROM flights WHERE airport = ? AND direction = ?";
  const params = [airport || "TPE", direction];

  if (!includeCargo) {
    // 旅客用航班看板預設不顯示貨機,跟真實機場顯示板一致
    sql += " AND is_cargo = 0";
  }
  if (date) {
    sql += " AND flight_date = ?";
    params.push(date);
  }
  if (hideDone) {
    // 已完成(有實際時間)的航班預設不顯示,聚焦在還沒發生的/進行中的航班
    sql += " AND actual_time IS NULL";
  }
  if (minTime) {
    // 表定時間在範圍內、或還在延誤/登機中(不管表定時間多早都保留顯示);
    // 取消的航班沒有這個例外,過了時間一樣不再顯示
    sql += ` AND (
      scheduled_time >= ? OR
      remark LIKE '%延誤%' OR remark LIKE '%登機%'
    )`;
    params.push(minTime);
  }
  if (terminal) {
    sql += " AND terminal = ?";
    params.push(terminal);
  }
  if (airline) {
    sql += " AND airline_id = ?";
    params.push(airline);
  }
  if (q) {
    sql += ` AND (
      flight_number LIKE ? OR
      departure_airport LIKE ? OR
      arrival_airport LIKE ?
    )`;
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  sql += " ORDER BY scheduled_time ASC";
  return db.prepare(sql).all(...params);
}

function logPoll(airport, direction, status, recordCount, message) {
  db.prepare(
    "INSERT INTO poll_log (direction, status, record_count, message) VALUES (?, ?, ?, ?)"
  ).run(`${airport}:${direction}`, status, recordCount ?? null, message ?? null);
}

function lastPollTime(airport) {
  const row = db
    .prepare("SELECT ran_at FROM poll_log WHERE status = 'ok' AND direction LIKE ? ORDER BY ran_at DESC LIMIT 1")
    .get(`${airport || "TPE"}:%`);
  return row ? row.ran_at : null;
}

module.exports = {
  saveArrivals,
  saveDepartures,
  queryFlights,
  logPoll,
  lastPollTime,
};
