(function () {
  "use strict";

  var REFRESH_MS = 30 * 1000;
  var STALE_AFTER_MS = 6 * 60 * 1000;

  var state = { airport: "TPE", direction: "arrival", terminal: "all", airline: "", query: "", cargo: false, history: false };
  var currentFlights = [];
  var rowFlights = [];
  var refreshTimer = null;
  var airportNames = {};

  function qs(params) {
    var pairs = [];
    Object.keys(params).forEach(function (key) {
      if (params[key]) pairs.push(encodeURIComponent(key) + "=" + encodeURIComponent(params[key]));
    });
    return pairs.length ? "?" + pairs.join("&") : "";
  }

  var STATUS_META = {
    done:      { cls: "st-good",     zh: "已完成" },
    ontime:    { cls: "st-good",     zh: "準時" },
    boarding:  { cls: "st-boarding", zh: "登機中" },
    delayed:   { cls: "st-warn",     zh: "延誤" },
    cancelled: { cls: "st-bad",      zh: "取消" },
  };

  function statusMeta(status) {
    return STATUS_META[status] || { cls: "st-neutral", zh: status };
  }

  function msIcon(name) {
    return '<span class="material-symbols-outlined">' + name + "</span>";
  }
  var ICON_PIN = msIcon("flight_takeoff");
  var ICON_CLOCK = msIcon("schedule");
  var ICON_GATE = msIcon("meeting_room");
  var ICON_PLANE = msIcon("airlines");

  function airlineLogo(code, name) {
    return '<img class="airline-logo" src="https://pics.avs.io/60/60/' + code + '.png" alt="' + name +
      '" loading="lazy" onerror="this.outerHTML=\'<span class=&quot;airline-logo fallback&quot;>' + code + '</span>\'">';
  }

  function renderHead() {
    var isArr = state.direction === "arrival";
    document.getElementById("tableHead").innerHTML =
      "<th>航空公司</th>" +
      "<th>班機號</th>" +
      "<th>" + (isArr ? "出發地" : "目的地") + "</th>" +
      "<th>表定 / 預計</th>" +
      "<th>登機門</th>" +
      "<th>航廈</th>" +
      "<th>機型</th>" +
      '<th class="num">' + (isArr ? "行李轉盤" : "報到櫃檯") + "</th>" +
      '<th class="num">狀態</th>';
  }

  function mstat(value, label, warn) {
    return '<div class="mstat"><b' + (warn ? ' class="warn"' : "") + ">" + value + "</b><span>" + label + "</span></div>";
  }

  function renderStats(summary) {
    var el = document.getElementById("statsRow");
    el.innerHTML =
      mstat(summary.total, "今日航班") +
      mstat(summary.onTimeRate + "%", "準點率", summary.onTimeRate < 85) +
      mstat(summary.delayed, "延誤中", summary.delayed > 0) +
      mstat(summary.done, (state.direction === "arrival" ? "已抵達" : "已出發"));
  }

  function fmtTime(iso) {
    if (!iso) return null;
    var t = iso.split("T")[1];
    return t ? t.slice(0, 5) : iso;
  }

  function timeCell(f) {
    var sched = fmtTime(f.scheduledTime) || "—";
    var actualOrEst = f.actualTime ? fmtTime(f.actualTime) : (f.estimatedTime ? fmtTime(f.estimatedTime) : null);

    if (f.status === "cancelled") {
      return '<div class="time-stack"><span class="cell-time">' + sched + '</span><hr class="time-divider">' +
        '<span class="cell-time time-sched">-</span></div>';
    }
    if (f.status === "delayed" && actualOrEst) {
      return '<div class="time-stack"><span class="cell-time time-strike">' + sched + '</span><hr class="time-divider">' +
        '<span class="cell-time time-sched shift">' + actualOrEst + "</span></div>";
    }
    var second = actualOrEst || sched;
    return '<div class="time-stack"><span class="cell-time time-actual">' + sched + '</span><hr class="time-divider">' +
      '<span class="cell-time time-sched">' + second + "</span></div>";
  }

  function dash(value) {
    return value ? value : '<span class="empty-dash">—</span>';
  }

  function matchesQuery(f, q) {
    if (!q) return true;
    q = q.toLowerCase();
    var isArr = state.direction === "arrival";
    var place = isArr ? f.origin : f.destination;
    var placeCity = isArr ? f.originCity : f.destinationCity;
    var codeshareNos = f.codeshares ? f.codeshares.map(function (c) { return c.flightNumber; }) : [];
    var haystack = [f.flightNumber, f.airlineName, place, placeCity].concat(codeshareNos).join(" ").toLowerCase();
    return haystack.indexOf(q) !== -1;
  }

  function renderCards(filtered, isArr) {
    var wrap = document.getElementById("flightCards");
    if (!filtered.length) {
      wrap.innerHTML = '<p class="state-msg">沒有符合篩選條件的航班</p>';
      return;
    }
    wrap.innerHTML = filtered.map(function (f, i) {
      var place = isArr ? f.origin : f.destination;
      var placeCity = isArr ? f.originCity : f.destinationCity;
      var sub = isArr ? f.baggageClaim : f.checkCounter;
      var subLabel = isArr ? "行李轉盤" : "報到櫃檯";
      var meta = statusMeta(f.status);
      return '<div class="fcard' + (f.status === "cancelled" ? " st-cancelled" : "") + '" data-idx="' + i + '">' +
        '<div class="fcard-top">' + airlineLogo(f.airlineId, f.airlineName) +
          '<div class="fcard-top-text"><div class="fcard-flightno' + (f.status === "cancelled" ? " time-strike" : "") + '">' + f.flightNumber +
          (f.codeshares && f.codeshares.length ? '<span class="codeshare-tag">/ ' + f.codeshares.map(function (c) { return c.flightNumber; }).join(" / ") + "</span>" : "") +
          '</div><div class="fcard-airline">' + f.airlineName + "</div></div>" +
          '<span class="chip ' + meta.cls + '">' + meta.zh + "</span></div>" +
        '<div class="fcard-route">' + ICON_PIN +
          '<div class="fcard-place"><div class="fcard-place-main">' + dash(placeCity || place) + '</div><div class="fcard-place-code">' + dash(place) + "</div></div>" +
          '<div class="fcard-time">' + timeCell(f) + "</div></div>" +
        '<div class="fcard-footer">' +
          "<div><span>航廈/登機門</span><b>" + dash(f.terminal ? "T" + f.terminal : null) + (f.gate ? " · " + f.gate : "") + "</b></div>" +
          "<div><span>機型</span><b>" + dash(f.acType) + "</b></div>" +
          "<div><span>" + subLabel + "</span><b>" + dash(sub) + "</b></div>" +
          "<div><span>狀態</span><b>" + meta.zh + "</b></div>" +
        "</div></div>";
    }).join("");
  }

  function renderBody(flights) {
    var isArr = state.direction === "arrival";
    var body = document.getElementById("tableBody");
    var filtered = flights.filter(function (f) { return matchesQuery(f, state.query); });

    rowFlights = filtered;
    renderCards(filtered, isArr);

    if (!filtered.length) {
      body.innerHTML = '<tr><td class="state-msg" colspan="9">沒有符合篩選條件的航班</td></tr>';
      return;
    }

    body.innerHTML = filtered.map(function (f, i) {
      var place = isArr ? f.origin : f.destination;
      var placeCity = isArr ? f.originCity : f.destinationCity;
      var placeLabel = placeCity ? placeCity + " " + place : place;
      var sub = isArr ? f.baggageClaim : f.checkCounter;
      var meta = statusMeta(f.status);
      return '<tr class="flight-row' + (f.status === "cancelled" ? " st-cancelled" : "") + '" data-idx="' + i + '">' +
        '<td><div class="flight-cell">' + airlineLogo(f.airlineId, f.airlineName) + '<span class="airline-name">' + f.airlineName + "</span></div></td>" +
        '<td><span class="flight-no' + (f.status === "cancelled" ? " time-strike" : "") + '">' + f.flightNumber +
          (f.codeshares && f.codeshares.length ? '<span class="codeshare-tag">/ ' + f.codeshares.map(function (c) { return c.flightNumber; }).join(" / ") + "</span>" : "") +
          "</span></td>" +
        '<td class="place-cell"><span class="icon-cell">' + ICON_PIN + '<span class="place-main">' + dash(placeLabel) + "</span></span></td>" +
        '<td><span class="icon-cell">' + ICON_CLOCK + timeCell(f) + "</span></td>" +
        '<td>' + (f.gate ? '<span class="icon-cell' + (f.status === "boarding" ? " gate-active" : "") + '">' + ICON_GATE + '<span class="gate-badge">' + f.gate + "</span></span>" : '<span class="empty-dash">—</span>') + "</td>" +
        '<td><span class="tmb">' + dash(f.terminal ? "T" + f.terminal : null) + "</span></td>" +
        '<td><span class="icon-cell">' + ICON_PLANE + "<span>" + dash(f.acType) + "</span></span></td>" +
        '<td class="num">' + dash(sub) + "</td>" +
        '<td class="num"><span class="chip ' + meta.cls + '">' + meta.zh + "</span></td>" +
        "</tr>";
    }).join("");
  }

  function populateAirlineFilter(flights) {
    var sel = document.getElementById("airlineFilter");
    var known = {};
    flights.forEach(function (f) { known[f.airlineId] = f.airlineName; });
    var codes = Object.keys(known).sort();
    var previous = sel.value;
    sel.innerHTML = '<option value="">所有航空公司</option>' + codes.map(function (code) {
      return '<option value="' + code + '">' + code + " ・ " + known[code] + "</option>";
    }).join("");
    if (codes.indexOf(previous) !== -1) sel.value = previous;
  }

  function setRow(id, sub, label, value) {
    var wrap = document.getElementById(id);
    if (!value) { wrap.style.display = "none"; return; }
    wrap.style.display = "";
    if (sub) document.getElementById(sub).textContent = value;
  }

  function openDetail(f) {
    var meta = statusMeta(f.status);
    var isArr = state.direction === "arrival";

    var detailLogo = document.getElementById("detailLogo");
    detailLogo.style.visibility = "visible";
    detailLogo.onerror = function () { this.style.visibility = "hidden"; };
    detailLogo.src = "https://pics.avs.io/60/60/" + f.airlineId + ".png";
    detailLogo.alt = f.airlineName;
    document.getElementById("detailFlightNo").textContent = f.flightNumber;
    document.getElementById("detailAirlineName").textContent = f.airlineName;
    var chip = document.getElementById("detailStatusChip");
    chip.className = "chip " + meta.cls;
    chip.textContent = meta.zh;

    document.getElementById("detailOrigin").textContent = f.origin || "—";
    document.getElementById("detailOriginCity").textContent = f.originCity || "";
    document.getElementById("detailDest").textContent = f.destination || "—";
    document.getElementById("detailDestCity").textContent = f.destinationCity || "";

    document.getElementById("detailSched").textContent = fmtTime(f.scheduledTime) || "—";

    var estVal = f.estimatedTime ? fmtTime(f.estimatedTime) : null;
    setRow("detailEstRow", "detailEst", "", estVal && estVal !== fmtTime(f.scheduledTime) ? estVal : null);

    var actVal = f.actualTime ? fmtTime(f.actualTime) : null;
    setRow("detailActualRow", "detailActual", "", actVal);

    var remarkEl = document.getElementById("detailRemark");
    if (f.remark) { remarkEl.textContent = f.remark; remarkEl.style.display = ""; }
    else { remarkEl.style.display = "none"; }

    document.getElementById("detailTerm").textContent = f.terminal ? "T" + f.terminal : "—";
    document.getElementById("detailGate").textContent = f.gate || "—";
    document.getElementById("detailAc").textContent = f.acType || "—";

    document.getElementById("detailSubLabel").textContent = isArr ? "行李轉盤" : "報到櫃檯";
    document.getElementById("detailSub").textContent = (isArr ? f.baggageClaim : f.checkCounter) || "—";

    var upd = f.updateTime ? fmtTime(f.updateTime) : null;
    document.getElementById("detailUpdated").textContent = upd ? "資料更新於 " + upd : "";

    document.getElementById("detailBackdrop").classList.add("open");
  }

  function closeDetail() {
    document.getElementById("detailBackdrop").classList.remove("open");
  }

  document.getElementById("tableBody").addEventListener("click", function (e) {
    var tr = e.target.closest("tr.flight-row");
    if (!tr) return;
    var f = rowFlights[Number(tr.getAttribute("data-idx"))];
    if (f) openDetail(f);
  });

  document.getElementById("flightCards").addEventListener("click", function (e) {
    var card = e.target.closest(".fcard");
    if (!card) return;
    var f = rowFlights[Number(card.getAttribute("data-idx"))];
    if (f) openDetail(f);
  });

  document.getElementById("detailClose").addEventListener("click", closeDetail);
  document.getElementById("detailBackdrop").addEventListener("click", function (e) {
    if (e.target.id === "detailBackdrop") closeDetail();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeDetail();
  });

  function formatUpdated(iso) {
    if (!iso) return { text: "尚未取得資料", stale: true };
    var ts = new Date(iso.replace(" ", "T") + "Z");
    if (isNaN(ts.getTime())) return { text: "尚未取得資料", stale: true };
    var stale = Date.now() - ts.getTime() > STALE_AFTER_MS;
    var local = ts.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour12: false, hour: "2-digit", minute: "2-digit" });
    return { text: "最後更新 " + local, stale: stale };
  }

  function setLiveState(info) {
    document.getElementById("updatedTag").textContent = info.text;
    document.getElementById("liveDot").classList.toggle("stale", info.stale);
    document.getElementById("liveLabel").textContent = info.stale ? "延遲中" : "即時";
  }

  function showError(message) {
    document.getElementById("tableBody").innerHTML =
      '<tr><td class="state-msg" colspan="7">' + message + "</td></tr>";
    document.getElementById("statsRow").innerHTML = "";
  }

  function load() {
    var params = {
      airport: state.airport,
      direction: state.direction,
      terminal: state.terminal === "all" ? "" : state.terminal,
      airline: state.airline,
      cargo: state.cargo ? "1" : "",
      all: state.history ? "1" : "",
    };

    Promise.all([
      fetch("/api/flights" + qs(params)).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }),
      fetch("/api/flights/stats" + qs({ airport: state.airport, direction: state.direction, cargo: state.cargo ? "1" : "" })).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }),
    ]).then(function (results) {
      var flightsRes = results[0];
      var statsRes = results[1];
      currentFlights = flightsRes.flights || [];
      renderHead();
      populateAirlineFilter(currentFlights);
      renderStats(statsRes);
      renderBody(currentFlights);
      setLiveState(formatUpdated(flightsRes.lastUpdated));
    }).catch(function (err) {
      console.error("[app] 載入航班資料失敗:", err);
      showError("航班資料載入失敗，請稍後重新整理（" + err.message + "）");
      setLiveState({ text: "更新失敗", stale: true });
    });
  }

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(load, REFRESH_MS);
  }

  document.querySelectorAll("[data-terminal]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("[data-terminal]").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      state.terminal = btn.getAttribute("data-terminal");
      load();
    });
  });

  document.querySelectorAll("[data-direction]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("[data-direction]").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      state.direction = btn.getAttribute("data-direction");
      load();
    });
  });

  document.getElementById("airlineFilter").addEventListener("change", function (e) {
    state.airline = e.target.value;
    load();
  });

  document.getElementById("cargoToggle").addEventListener("change", function (e) {
    state.cargo = e.target.checked;
    load();
  });

  document.getElementById("historyBtn").addEventListener("click", function () {
    state.history = !state.history;
    this.classList.toggle("active", state.history);
    this.textContent = state.history ? "回到即時" : "查看更早航班";
    load();
  });

  function updatePageTitle() {
    var name = airportNames[state.airport] || state.airport;
    document.getElementById("pageTitle").firstChild.textContent = name;
    document.getElementById("pageSubtitle").textContent = "即時航班看板・" + state.airport + " Airport Live Status";
  }

  function loadAirports() {
    fetch("/api/airports").then(function (r) { return r.json(); }).then(function (res) {
      var sel = document.getElementById("airportSelect");
      res.airports.forEach(function (a) {
        airportNames[a.code] = a.name;
        var opt = document.createElement("option");
        opt.value = a.code;
        opt.textContent = a.code;
        sel.appendChild(opt);
      });
      sel.value = state.airport;
      updatePageTitle();
    }).catch(function (err) {
      console.error("[app] 載入機場清單失敗:", err);
    });
  }

  document.getElementById("airportSelect").addEventListener("change", function (e) {
    state.airport = e.target.value;
    updatePageTitle();
    load();
  });

  var searchDebounce = null;
  document.getElementById("searchBox").addEventListener("input", function (e) {
    var value = e.target.value.trim();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () {
      state.query = value;
      renderBody(currentFlights);
    }, 120);
  });

  loadAirports();
  load();
  scheduleRefresh();
})();
