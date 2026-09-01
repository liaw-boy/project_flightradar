'use strict';
// Broadcast cadence smoothing ─────────────────────────────────────────
// Tier 1 (global baseline) and Tier 2 (viewport overlay) each poll on their
// own independent 5s setInterval, unsynchronized with each other. Measured
// live: the resulting WebSocket delta arrival gaps swing anywhere from
// ~300ms to ~6800ms for the same set of aircraft, cycle to cycle — trigger-
// based throttling (only enforcing a minimum gap) doesn't fix this, since
// the *maximum* gap is still whatever the two unsynchronized 5s pollers
// happen to leave between their broadcasts. The frontend derives its
// interpolation duration from that arrival gap, so the same physical
// movement gets animated over a 0.3s window one moment and a 6s+ window the
// next; when two broadcasts land close together, the prior animation hasn't
// finished before the next target arrives, which reads visually as the
// plane snapping backward. The fix is a real fixed-cadence ticker, fully
// decoupled from when either tier happens to fire: pruneAndBroadcast() only
// marks state dirty; a separate setInterval flushes on a constant rhythm.
// This fixes the delivery-side half of the "忽快忽慢/前進倒退" symptom;
// isPositionUpdateTrustworthy() (services/stateMerge.js) fixes the data-side half.
const { broadcastPlanes } = require('../socketEngine');
const { masterStateMap, recentTrackBuffer, pendingPredictions, notifiedEmergencies, notifiedMilitary, notifiedSpecialLivery, getGlobalPlanesCache, setGlobalPlanesCache } = require('../state/appState');
const { predictBatch } = require('./trajectoryPredictor');
const { getDistance } = require('../utils/planeGuards');
const predictionLogStore = require('../db/predictionLogStore');
const { notifyDiscord } = require('./discordNotifier');
const SPECIAL_LIVERIES = require('../data/specialLiveries.json');

const EMERGENCY_SQUAWK_LABELS = { '7500': '劫機 (Hijack)', '7600': '通訊失效 (Radio Failure)', '7700': '一般緊急 (General Emergency)' };

// Taiwan + approach/nearby airspace, generous enough to cover ADIZ-adjacent
// activity without being global (military aircraft are airborne somewhere
// in the world at every moment — unscoped would be constant noise).
const TAIWAN_ALERT_BBOX = { latMin: 20, latMax: 27, lngMin: 117, lngMax: 124 };
function _inTaiwanAlertBbox(lat, lng) {
    return lat >= TAIWAN_ALERT_BBOX.latMin && lat <= TAIWAN_ALERT_BBOX.latMax &&
           lng >= TAIWAN_ALERT_BBOX.lngMin && lng <= TAIWAN_ALERT_BBOX.lngMax;
}

// Shared by all three Discord alerts below — reuses the existing
// /api/route/:icao24 resolution chain (adsbdb/VRS/local schedules, already
// cross-checked against the aircraft's own ground position for plausibility)
// via loopback HTTP rather than duplicating that logic here. Best-effort:
// most planes won't have a resolved route yet, so a miss just omits the
// line instead of blocking the alert.
function _notifyLeftScope(icao24, p, type) {
    const callsign = (p.callsign && p.callsign !== 'N/A') ? p.callsign : icao24;
    const siteUrl = process.env.APP_URL || 'https://flyradar.spkuan.cc';
    const cfg = type === 'military'
        ? { icon: 'military', title: '軍機離開台灣周邊空域', webhook: 'DISCORD_MILITARY_WEBHOOK_URL' }
        : { icon: 'livery', title: `彩繪機離開台灣周邊空域 — ${SPECIAL_LIVERIES[p.registration?.toUpperCase()] || ''}`, webhook: 'DISCORD_LIVERY_WEBHOOK_URL' };
    notifyDiscord({
        icon: cfg.icon, color: 'gray',
        title: cfg.title,
        url: `${siteUrl}/?icao=${icao24}`,
        description: `呼號: **${callsign}**　ICAO24: ${icao24}\n最後位置: ${p.lat?.toFixed(4)}, ${p.lng?.toFixed(4)}`,
    }, cfg.webhook);
}

async function _fetchRouteLine(icao24, callsign, onGround) {
    try {
        const port = process.env.PORT || 3000;
        const cs = encodeURIComponent(callsign || '');
        const res = await fetch(`http://127.0.0.1:${port}/api/route/${icao24}?callsign=${cs}`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        if (!data?.departureAirport || !data?.arrivalAirport) return null;
        const statusLabel = onGround ? '地面' : '飛行中';
        return `起飛: **${data.departureAirport}**　降落: **${data.arrivalAirport}**　狀態: ${statusLabel}`;
    } catch (_) {
        return null; // no route resolved yet, or the internal call itself failed — omit, don't block the alert
    }
}

const PLANE_TTL_MS = 90_000;       // 90s without update → remove from map
const BROADCAST_INTERVAL_MS = 2000;
// Below this age, a plane is just between polls — show its real last-known
// position. Above it (but under PLANE_TTL_MS), signal has likely dropped;
// extrapolate with the LSTM predictor instead of leaving it frozen on-screen.
const PREDICT_GRACE_MS = 6_000;
const PREDICTOR_WINDOW_SIZE = 10; // must match ml_trajectory/model.py WINDOW_SIZE
// Must match ml_trajectory/dataset.py's RESAMPLE_DT_S — the model was
// retrained to predict exactly this many seconds ahead per rollout step
// (see the 2026-08-31 fix for the 135-180km ambiguous-horizon bug), so a
// plane stale for `age` ms needs ceil(age / this) rollout steps from
// infer_server.py's autoregressive extrapolation, not a fixed 1.
const PREDICTOR_STEP_S = 5;
let _broadcastDirty = false;

// pruneAndBroadcast is called fire-and-forget from three independently-
// timed pollers (baseline 5s, viewport 5s, special 60s — see pollers.js).
// Each poller guards against re-entering ITSELF, but nothing previously
// guarded pruneAndBroadcast against two DIFFERENT pollers' calls overlapping
// here. Because this function does `await predictBatch(...)` partway
// through (an HTTP round-trip), two overlapping calls can finish in either
// order — whichever's predictBatch call happens to return last wins the
// final setGlobalPlanesCache() write, which is not necessarily the call
// that started with the freshest masterStateMap snapshot. A skip-if-busy
// guard (matching the style already used for the pollers themselves) means
// a rare overlap just skips one cycle rather than risking a stale
// overwrite — the next 2-5s tick catches up regardless.
let _pruneAndBroadcastRunning = false;

async function pruneAndBroadcast() {
    if (_pruneAndBroadcastRunning) return;
    _pruneAndBroadcastRunning = true;
    try {
        await _pruneAndBroadcastImpl();
    } finally {
        _pruneAndBroadcastRunning = false;
    }
}

async function _pruneAndBroadcastImpl() {
    // Staleness is measured from _posUpdatedAt (last time the position
    // actually advanced), not _lastSeen (last time this icao24 merely
    // appeared in an upstream poll response). An upstream feed that keeps
    // re-reporting a frozen position for a lost-signal aircraft refreshes
    // _lastSeen every cycle forever — keying staleness off it meant the
    // plane never hit the TTL prune and never triggered gap-fill
    // prediction, so it just sat frozen on-screen indefinitely. See
    // stateMerge.js's _posUpdatedAt comment for the full explanation.
    const now = Date.now();
    const cutoff = now - PLANE_TTL_MS;
    for (const [id, p] of masterStateMap) {
        const staleSince = p._posUpdatedAt ?? p._lastSeen ?? 0;
        if (staleSince < cutoff) {
            // Signal lost entirely while still flagged — that also counts as
            // "left", using its last known position/callsign before it's gone.
            if (notifiedMilitary.has(id)) _notifyLeftScope(id, p, 'military');
            if (notifiedSpecialLivery.has(id)) _notifyLeftScope(id, p, 'livery');
            masterStateMap.delete(id);
            recentTrackBuffer.delete(id);
            pendingPredictions.delete(id);
            notifiedEmergencies.delete(id);
            notifiedMilitary.delete(id);
            notifiedSpecialLivery.delete(id);
        }
    }

    // ── Emergency squawk alert (Discord) ────────────────────────────────────
    // Edge-triggered: fires once when a plane's isEmergency flips true, not
    // every 2s cycle it stays that way — a plane can squawk 7700 for the
    // rest of its flight, and nobody wants that spamming the channel.
    // notifiedEmergencies is cleared above once the plane is pruned, so a
    // later flight leg re-squawking emergency notifies again.
    for (const [icao24, p] of masterStateMap) {
        if (p.isEmergency && !notifiedEmergencies.has(icao24)) {
            notifiedEmergencies.add(icao24);
            const label = EMERGENCY_SQUAWK_LABELS[p.squawk] || `squawk ${p.squawk || '?'}`;
            const callsign = (p.callsign && p.callsign !== 'N/A') ? p.callsign : icao24;
            // Deep link into the live map — clicking the alert title in Discord
            // opens the site with this aircraft selected (App.jsx reads ?icao=).
            const siteUrl = process.env.APP_URL || 'https://flyradar.spkuan.cc';
            (async () => {
                const routeLine = await _fetchRouteLine(icao24, callsign, p.onGround);
                notifyDiscord({
                    icon: 'emergency', color: 'red',
                    title: `緊急狀態飛機 — ${label}`,
                    url: `${siteUrl}/?icao=${icao24}`,
                    description: `呼號: **${callsign}**　ICAO24: ${icao24}\n位置: ${p.lat?.toFixed(4)}, ${p.lng?.toFixed(4)}　高度: ${Math.round(p.altitude || 0)}m` +
                        (routeLine ? `\n${routeLine}` : ''),
                }, 'DISCORD_EMERGENCY_WEBHOOK_URL');
            })();
        } else if (!p.isEmergency && notifiedEmergencies.has(icao24)) {
            notifiedEmergencies.delete(icao24);
        }
    }

    // ── Military aircraft alert (Discord) ───────────────────────────────────
    // Edge-triggered like the emergency alert, and scoped to
    // TAIWAN_ALERT_BBOX (Taiwan + nearby airspace) — unscoped would fire
    // constantly, since military aircraft are airborne somewhere in the
    // world at every moment.
    for (const [icao24, p] of masterStateMap) {
        const inScope = p.isMil && typeof p.lat === 'number' && typeof p.lng === 'number' && _inTaiwanAlertBbox(p.lat, p.lng);
        if (inScope && !notifiedMilitary.has(icao24)) {
            notifiedMilitary.add(icao24);
            const callsign = (p.callsign && p.callsign !== 'N/A') ? p.callsign : icao24;
            const siteUrl = process.env.APP_URL || 'https://flyradar.spkuan.cc';
            (async () => {
                // Military flights rarely have a resolved civilian route — this
                // will usually come back null and just be omitted, which is fine.
                const routeLine = await _fetchRouteLine(icao24, callsign, p.onGround);
                notifyDiscord({
                    icon: 'military', color: 'orange',
                    title: '軍機進入台灣周邊空域',
                    url: `${siteUrl}/?icao=${icao24}`,
                    description: `呼號: **${callsign}**　ICAO24: ${icao24}\n位置: ${p.lat?.toFixed(4)}, ${p.lng?.toFixed(4)}　高度: ${Math.round(p.altitude || 0)}m　機型: ${p.typecode || '未知'}` +
                        (routeLine ? `\n${routeLine}` : ''),
                }, 'DISCORD_MILITARY_WEBHOOK_URL');
            })();
        } else if (!inScope && notifiedMilitary.has(icao24)) {
            _notifyLeftScope(icao24, p, 'military');
            notifiedMilitary.delete(icao24);
        }
    }

    // ── Special-livery aircraft alert (Discord, with photo) ─────────────────
    // Matched by registration against data/specialLiveries.json (a small,
    // manually-curated list — ADS-B itself carries no livery information).
    // Scoped to the same Taiwan-vicinity bbox as the military alert — these
    // aircraft fly internationally (Hello Kitty jet to Chicago, STARLUX
    // A350s worldwide), so unscoped would notify wherever on Earth they
    // happen to be, not just "arriving near Taiwan" which is what's useful.
    // Edge-triggered like the other alerts. Photo comes from the existing
    // /api/photos endpoint via loopback HTTP rather than duplicating its
    // Planespotters-fetch logic here; fire-and-forget since it involves a
    // network round trip and must never block the 2s broadcast tick.
    for (const [icao24, p] of masterStateMap) {
        const reg = p.registration && p.registration.toUpperCase();
        const liveryName = reg && SPECIAL_LIVERIES[reg];
        const inScope = liveryName && typeof p.lat === 'number' && typeof p.lng === 'number' && _inTaiwanAlertBbox(p.lat, p.lng);
        if (inScope && !notifiedSpecialLivery.has(icao24)) {
            notifiedSpecialLivery.add(icao24);
            const callsign = (p.callsign && p.callsign !== 'N/A') ? p.callsign : icao24;
            const siteUrl = process.env.APP_URL || 'https://flyradar.spkuan.cc';
            const port = process.env.PORT || 3000;
            (async () => {
                let photoUrl = null;
                try {
                    const res = await fetch(`http://127.0.0.1:${port}/api/photos/${icao24}?reg=${reg}`, { signal: AbortSignal.timeout(8000) });
                    const photos = await res.json();
                    photoUrl = Array.isArray(photos) && photos[0]?.thumbnail_large?.src;
                } catch (_) { /* no photo available — notify without one rather than dropping the alert */ }
                const routeLine = await _fetchRouteLine(icao24, callsign, p.onGround);
                notifyDiscord({
                    icon: 'livery', color: 'green',
                    title: `彩繪機出現 — ${liveryName}`,
                    url: `${siteUrl}/?icao=${icao24}`,
                    description: `呼號: **${callsign}**　登記號: ${reg}\n位置: ${p.lat?.toFixed(4)}, ${p.lng?.toFixed(4)}` +
                        (routeLine ? `\n${routeLine}` : ''),
                    image: photoUrl || undefined,
                }, 'DISCORD_LIVERY_WEBHOOK_URL');
            })();
        } else if (!inScope && notifiedSpecialLivery.has(icao24)) {
            _notifyLeftScope(icao24, p, 'livery');
            notifiedSpecialLivery.delete(icao24);
        }
    }

    // ── Prediction Log (feedback loop for retrain_and_promote.py) ──────────
    // Each plane's prediction from the PREVIOUS cycle sat "pending" until a
    // genuinely new real position arrived to check it against (comparing
    // against the same stale point twice would just log a fake zero error).
    // "Genuinely new" = _posUpdatedAt advanced past the value recorded when
    // that prediction was made — the same signal broadcastEngine already
    // uses elsewhere to distinguish a real update from a repeated one.
    const logRows = [];
    for (const [icao24, pending] of pendingPredictions) {
        const p = masterStateMap.get(icao24);
        if (!p) { pendingPredictions.delete(icao24); continue; }
        const posUpdatedAt = p._posUpdatedAt ?? p._lastSeen ?? 0;
        if (posUpdatedAt <= pending.baselinePosUpdatedAt) continue; // still waiting on a real update
        logRows.push({
            icao24,
            ts: Math.floor(posUpdatedAt / 1000),
            predictedLat: pending.lat,
            predictedLng: pending.lng,
            predictedAltitude: pending.altitude,
            actualLat: p.lat,
            actualLng: p.lng,
            actualAltitude: p.altitude,
            errorKm: getDistance(pending.lat, pending.lng, p.lat, p.lng),
            stepsAhead: pending.stepsAhead ?? null,
        });
        pendingPredictions.delete(icao24);
    }
    if (logRows.length > 0) {
        try { predictionLogStore.insertMany(logRows); } catch (_) { /* best-effort — never block broadcasting on log writes */ }
    }

    // Predict for every plane with a full buffer, not just stale ones —
    // purely for background accuracy logging (prediction_log) right now.
    // [2026-08-31] Was also used to gap-fill/blend the DISPLAYED position
    // (both here and in MapView.jsx's Phase 2) — reverted after that path
    // produced two live bugs (predicting for landed aircraft; per-prediction
    // direction noise read as visible jitter). See the plan doc
    // (lively-spinning-stream.md) for the staged re-enablement path. This
    // loop and predictBatch() call are kept running so prediction_log keeps
    // accumulating real accuracy data during the validation period —
    // stopping it would blind the exact measurement the next stage needs.
    const predictItems = [];
    for (const [icao24, p] of masterStateMap) {
        // Training data is airborne-only (ml_trajectory/dataset.py's
        // `on_ground = 0` filter) — applying the model to a landed/taxiing
        // aircraft extrapolates flight-regime dynamics onto ground movement
        // it was never trained on, producing nonsense positions (a landed
        // plane "flying" off to somewhere else). recentTrackBuffer itself
        // only ever contains airborne points (see trackIngest.js), but a
        // plane that landed AFTER its buffer filled would still have a
        // full, buffer, so this check has to be against current state, too.
        if (p.onGround) continue;
        const buf = recentTrackBuffer.get(icao24);
        if (!buf || buf.length < PREDICTOR_WINDOW_SIZE) continue;
        const ageS = (now - (p._posUpdatedAt ?? p._lastSeen ?? now)) / 1000;
        const stepsAhead = Math.max(1, Math.round(ageS / PREDICTOR_STEP_S));
        predictItems.push({ icao24, sequence: buf, stepsAhead });
    }

    // masterStateMap entries are left untouched — only the broadcast/cache
    // snapshot gets the extrapolated position, so a real update arriving
    // late still merges against the last genuine state, not a guess.
    let states = Array.from(masterStateMap.values());
    if (predictItems.length > 0) {
        const stepsAheadByIcao = new Map(predictItems.map(it => [it.icao24, it.stepsAhead]));
        const predictions = await predictBatch(predictItems);
        if (predictions.size > 0) {
            for (const [icao24, pred] of predictions) {
                const p = masterStateMap.get(icao24);
                pendingPredictions.set(icao24, {
                    lat: pred.lat,
                    lng: pred.lng,
                    altitude: pred.altitude,
                    stepsAhead: stepsAheadByIcao.get(icao24),
                    baselinePosUpdatedAt: p?._posUpdatedAt ?? p?._lastSeen ?? now,
                });
            }
            states = states.map((p) => {
                const pred = predictions.get(p.icao24);
                if (!pred) return p;
                // [2026-08-31] Was overwriting lat/lng/altitude with the
                // model's prediction once a plane went stale past
                // PREDICT_GRACE_MS ("gap-fill"). Reverted: checked tar1090
                // (the reference open-source ADS-B web client) — it never
                // guesses a position, it just holds the last real one until
                // the next update arrives. Doing the same here: attach
                // predictedLat/Lng/Altitude as extra info only, never touch
                // the actual displayed lat/lng/altitude. Frontend's Phase 2
                // blend (which consumed these fields) is also disabled for
                // the same reason — see MapView.jsx.
                return {
                    ...p,
                    predictedLat: pred.lat,
                    predictedLng: pred.lng,
                    predictedAltitude: pred.altitude,
                };
            });
        }
    }

    setGlobalPlanesCache({ states, time: Math.floor(Date.now() / 1000), stale: false });
    _broadcastDirty = true; // picked up by the flush ticker below
}

function startBroadcastTicker() {
    return setInterval(() => {
        if (!_broadcastDirty) return;
        _broadcastDirty = false;
        broadcastPlanes(getGlobalPlanesCache().states, getGlobalPlanesCache().time);
    }, BROADCAST_INTERVAL_MS);
}

module.exports = { PLANE_TTL_MS, pruneAndBroadcast, startBroadcastTicker };
