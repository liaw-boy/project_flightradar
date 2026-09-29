'use strict';
// [v11.0] Three-Tier Polling Engine — Tier 1 (global baseline), Tier 2
// (viewport overlay), Tier 3 (special categories: military/LADD), plus
// enrichAndIngest (typecode/operator/model enrichment + TrackPoint write).
//
// ingestTrackPoints is factory-injected rather than required directly: it's
// produced by server.js's createTrackIngest() call, which closes over
// Route/TrackPoint/FlightSession/broadcastTrackPoint — re-requiring that
// factory here would construct a second, unsynced set of instances.
// triggerBackgroundResolution is likewise a plain function living in
// server.js's module scope (its own pendingResolutions Set), not something
// requirable on its own. normalizeAcRecord has no such state and could be
// required directly from planeSources.js, but stays injected for symmetry.
const logger = require('../logger');
const { cbOpen, cbTrip, cbReset, logSuppressedSource } = require('./circuitBreaker');
const { mergeStates } = require('./stateMerge');
const { pruneAndBroadcast } = require('./broadcastEngine');
const { isValidTypecode } = require('../utils/planeGuards');
const {
    masterStateMap, aircraftMetadataIndex, ingestionStats, activeSessions,
    getGlobalPlanesCache,
} = require('../state/appState');
const { getActiveViewports, getClientCount } = require('../socketEngine');
const Aircraft = require('../db/aircraftStore');
const MictronicsDb = require('../db/mictronicsDb');
const { notifyDiscord } = require('./discordNotifier');
const { createStuckGuard } = require('../utils/stuckGuard');

function createPollers({ normalizeAcRecord, ingestTrackPoints, triggerBackgroundResolution }) {

    // ── Tier 1: Global Baseline ────────────────────────────────────────────────
    // Primary: adsb.lol (no quota, 15s interval — see server.js's
    // setInterval(fetchGlobalBaseline, ...) for the current value and why)
    // Fallback: adsb.fi snapshot (if adsb.lol fails)

    // A single failed cycle (one source hiccup) is normal and already handled by
    // the per-source circuit breakers. This tracks the harder failure: adsb.lol
    // AND adsb.fi-snap both empty in the same cycle — the whole tier is dark,
    // not just one upstream. Escalates to an ERROR-level, throttled alert once
    // that's been true for several consecutive cycles, so it's visible without
    // a human having to notice the map went stale.
    let _consecutiveTotalOutageCycles = 0;
    // [2026-09-01] Was 3 (~15s). Raised to 8 back when there was a third
    // fallback tier (OpenSky, since removed — see git history) whose own
    // independent 30s throttle window meant every gap between its attempts
    // legitimately reported "all sources failed" and falsely tripped a 15s
    // threshold. That specific false-positive source is gone now that this is
    // strictly a two-source (adsb.lol/adsb.fi-snap) check, but the 8-cycle
    // debounce is still a reasonable guard against a handful of transient
    // blips landing back-to-back, so it's left as-is rather than re-tuned
    // without real outage data to tune it against.
    //
    // Must match setInterval(fetchGlobalBaseline, ...) in server.js — used
    // below to report actual outage duration. This drifted silently before
    // (hardcoded as "* 5" for the original 5s interval, still "* 5" after
    // the interval moved to 10s, so every outage alert under-reported its
    // real duration by 2x); named here so a future interval change can't
    // silently do the same thing a third time.
    const GLOBAL_BASELINE_INTERVAL_SEC = 15;
    const TOTAL_OUTAGE_ALERT_THRESHOLD = 8;       // ~120s of zero data at the 15s poll interval
    const TOTAL_OUTAGE_ALERT_THROTTLE_MS = 5 * 60_000; // re-announce at most once per 5 min while it persists
    let _lastTotalOutageAlertAt = 0;
    // [2026-09-09] Down-detection was debounced (8 consecutive failed cycles)
    // but recovery was not — a single successful cycle right after the alert
    // fired immediately reset the outage counter and sent "已恢復", even when
    // the upstream was still flapping and died again on the very next cycle.
    // That produced the 恢復→全滅→恢復 spam seen in Discord within minutes.
    // Mirror the same debounce on the way back up: only announce recovery
    // once the source has stayed healthy for several consecutive cycles.
    let _outageAlertActive = false;   // true once the down-alert has actually fired
    let _recoverySuccessStreak = 0;
    const RECOVERY_CONFIRM_CYCLES = 3; // ~15s of sustained data before declaring recovered

    const _baselineGuard = createStuckGuard('fetchGlobalBaseline', notifyDiscord);
    async function fetchGlobalBaseline() {
        if (_baselineGuard.shouldSkip()) return;
        _baselineGuard.enter();
        const t0 = performance.now();

        try {
            // [2026-09-29] adsb.fi-snap used to fire in parallel every single
            // cycle as a "hot standby", even though its data was thrown away
            // on the (overwhelming majority of) cycles where adsb.lol
            // succeeded — ~5,760 calls/day to a free community API for a
            // fallback that's almost never actually used. adsb.fi's own
            // policy counts 403/429 responses toward its abuse threshold, so
            // hitting it every 15s while blocked also kept re-arming its own
            // restriction (see circuitBreaker.js's FAILURE_TIERS comment —
            // this is the same "we kept refreshing our own block" pattern
            // that caused the 2.9-day outage there). Now sequential and
            // on-demand: adsb.fi is only called at all when adsb.lol's own
            // request for this cycle actually failed. Costs a few hundred ms
            // of extra latency on a genuine adsb.lol failure; adsb.lol has
            // otherwise been reliable, so that's the right trade.
            let lolR;
            try {
                lolR = cbOpen('adsb.lol')
                    ? { status: 'rejected', reason: new Error('CB open') }
                    : { status: 'fulfilled', value: await fetch('https://api.adsb.lol/v2/lat/0/lon/0/dist/99999', {
                          headers: { 'User-Agent': 'AEROSTRAT/12.0' },
                          signal: AbortSignal.timeout(8000),
                      }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))) };
            } catch (e) {
                lolR = { status: 'rejected', reason: e };
            }

            let lolStates = [];
            let fiStates  = [];

            if (lolR.status === 'fulfilled') {
                lolStates = (lolR.value.ac || []).map(p => normalizeAcRecord(p, lolR.value.now))
                    .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
                cbReset('adsb.lol', lolStates.length, Math.round(performance.now() - t0));
            } else {
                const msg = lolR.reason?.message || '';
                if (msg === 'CB open') logSuppressedSource('adsb.lol');
                else {
                    // Trip on ANY failure, not just explicit 429/403 — a network-level
                    // timeout ("fetch failed" / "operation was aborted") never carries
                    // an HTTP status, so it fell through a status-only check entirely
                    // and the 5s poll kept hammering a host that wasn't responding at
                    // all. cbTrip classifies the reason itself now (circuitBreaker.js)
                    // so a plain timeout only costs a short, quickly-escalating
                    // cooldown while a confirmed 403/429 gets the longer one it
                    // actually warrants.
                    cbTrip('adsb.lol', msg);
                    logger.warn('SYNC', `adsb.lol failed: ${msg}`);
                }
            }

            // Only reached for the minority of cycles where adsb.lol didn't
            // already produce usable states — see comment above.
            if (lolStates.length === 0) {
                let fiR;
                try {
                    fiR = cbOpen('adsb.fi-snap')
                        ? { status: 'rejected', reason: new Error('CB open') }
                        : { status: 'fulfilled', value: await fetch('https://opendata.adsb.fi/api/v2/snapshot', {
                              headers: { 'User-Agent': 'AEROSTRAT/12.0' },
                              signal: AbortSignal.timeout(10000),
                          }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))) };
                } catch (e) {
                    fiR = { status: 'rejected', reason: e };
                }

                if (fiR.status === 'fulfilled') {
                    fiStates = (fiR.value.ac || []).map(p => normalizeAcRecord(p, fiR.value.now))
                        .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
                    cbReset('adsb.fi-snap', fiStates.length, Math.round(performance.now() - t0));
                } else {
                    const msg = fiR.reason?.message || '';
                    if (msg === 'CB open') logSuppressedSource('adsb.fi-snap');
                    else {
                        cbTrip('adsb.fi-snap', msg);
                        logger.warn('SYNC', `adsb.fi-snap failed: ${msg}`);
                    }
                }
            }

            const states = lolStates.length > 0 ? lolStates : fiStates;
            const source = lolStates.length > 0 ? 'adsb.lol' : (fiStates.length > 0 ? 'adsb.fi-snap' : '');

            if (states.length === 0) {
                logger.warn('SYNC', 'Global baseline: all sources failed — using stale cache');
                getGlobalPlanesCache().stale = true;

                _consecutiveTotalOutageCycles++;
                _recoverySuccessStreak = 0; // any failure cancels a recovery in progress
                if (_consecutiveTotalOutageCycles >= TOTAL_OUTAGE_ALERT_THRESHOLD) {
                    const now = Date.now();
                    if (now - _lastTotalOutageAlertAt >= TOTAL_OUTAGE_ALERT_THROTTLE_MS) {
                        _lastTotalOutageAlertAt = now;
                        _outageAlertActive = true;
                        const outageSec = _consecutiveTotalOutageCycles * GLOBAL_BASELINE_INTERVAL_SEC;
                        logger.error('ALERT', `Global baseline dark for ${outageSec}s+ — adsb.lol AND adsb.fi-snap both failed this cycle. Map is serving stale data.`);
                        notifyDiscord({
                            icon: 'outageDown', color: 'orange',
                            title: 'AEROSTRAT 資料來源全滅',
                            description: `adsb.lol、adsb.fi-snap 兩個來源同一輪都失敗，已持續 **${outageSec} 秒**以上，地圖目前在用舊快取撐著（stale）。\n（每 5 分鐘最多重複提醒一次，直到恢復為止）`,
                        }, 'DISCORD_OUTAGE_WEBHOOK_URL');
                    }
                }
                return;
            }
            if (_outageAlertActive) {
                // Require several consecutive healthy cycles before declaring
                // recovery — a lone successful poll right after an outage is
                // often just the upstream flickering, not a real recovery.
                _recoverySuccessStreak++;
                if (_recoverySuccessStreak < RECOVERY_CONFIRM_CYCLES) {
                    // Still probationary: keep serving data (states aren't discarded
                    // below) but don't reset the outage bookkeeping yet.
                } else {
                    const outageSec = _consecutiveTotalOutageCycles * GLOBAL_BASELINE_INTERVAL_SEC;
                    notifyDiscord({
                        icon: 'outageUp', color: 'green',
                        title: 'AEROSTRAT 資料來源已恢復',
                        description: `先前中斷約 **${outageSec} 秒**，目前來源: ${source}`,
                    }, 'DISCORD_OUTAGE_WEBHOOK_URL');
                    _outageAlertActive = false;
                    _recoverySuccessStreak = 0;
                    _consecutiveTotalOutageCycles = 0;
                }
            } else {
                _consecutiveTotalOutageCycles = 0;
            }

            mergeStates(states, 'upsert');
            pruneAndBroadcast();
            logger.info('SYNC', `✅ Global baseline: ${states.length} planes | source: ${source} | ${Math.round(performance.now()-t0)}ms`);

            await enrichAndIngest();

        } catch (e) {
            logger.error('SYNC', `Global baseline error: ${e.message}`);
            getGlobalPlanesCache().stale = true;
        } finally {
            _baselineGuard.exit();
        }
    }

    // ── Tier 2: Viewport Overlay ───────────────────────────────────────────────
    const _viewportGuard = createStuckGuard('fetchViewportOverlay', notifyDiscord);
    async function fetchViewportOverlay() {
        if (_viewportGuard.shouldSkip()) return;
        _viewportGuard.enter();
        const t0 = performance.now();

        try {
            const viewports = getActiveViewports();
            const vp = viewports.length > 0 ? viewports[0] : null;
            if (!vp) return; // No active clients — skip viewport fetch to save bandwidth & CPU
            const lat = ((vp.lamin + vp.lamax) / 2).toFixed(4);
            const lon = ((vp.lomin + vp.lomax) / 2).toFixed(4);

            // [2026-09-29] re-api.adsb.lol removed from this tier. Their own
            // docs: RE-API "is only accessible from the same IP address as
            // active adsb.lol feeders" — confirmed via direct test that this
            // host (which doesn't run a feeder) gets a flat 403 from it,
            // structurally, not as a temporary block. Unlike al-point/adsb.fi
            // (fixable via an access request or already working), no retry
            // or backoff schedule ever makes this succeed short of actually
            // running a feeder here. Kept as a single call instead of a
            // parallel-then-merge pair; adsb.fi-v3 below is still the real
            // fallback for when al-point itself is unavailable.
            let alR;
            try {
                alR = cbOpen('al-point')
                    ? { status: 'rejected', reason: new Error('CB open') }
                    : { status: 'fulfilled', value: await fetch(`https://api.airplanes.live/v2/point/${lat}/${lon}/250`, {
                          headers: { 'User-Agent': 'AEROSTRAT/11.0' },
                          signal: AbortSignal.timeout(8000),
                      }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))) };
            } catch (e) {
                alR = { status: 'rejected', reason: e };
            }

            let vpStates = [];
            let vpSources = [];

            if (alR.status === 'fulfilled') {
                const states = (alR.value.ac || []).map(p => normalizeAcRecord(p, alR.value.now))
                    .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
                vpStates = vpStates.concat(states);
                vpSources.push('al-point');
                cbReset('al-point', states.length, Math.round(performance.now() - t0));
            } else {
                const msg = alR.reason?.message || '';
                if (msg !== 'CB open') cbTrip('al-point', msg);
            }

            // Fallback: adsb.fi v3 if al-point failed
            if (vpStates.length === 0 && !cbOpen('adsb.fi-v3')) {
                try {
                    const r = await fetch(
                        `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/250`,
                        { headers: { 'User-Agent': 'AEROSTRAT/11.0' }, signal: AbortSignal.timeout(8000) }
                    );
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    const data = await r.json();
                    vpStates = (data.ac || []).map(p => normalizeAcRecord(p, data.now))
                        .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
                    vpSources.push('adsb.fi-v3');
                    cbReset('adsb.fi-v3', vpStates.length, Math.round(performance.now() - t0));
                } catch (e) {
                    cbTrip('adsb.fi-v3', e.message);
                }
            }

            if (vpStates.length > 0) {
                mergeStates(vpStates, 'merge');  // merge: preserve existing desc/year/typecode
                pruneAndBroadcast();
                // Ingest the post-arbitration positions from masterStateMap, not
                // the raw vpStates — mergeStates() may have rejected a stale or
                // implausible position for a given aircraft this cycle, and
                // ingesting vpStates directly bypassed that check entirely,
                // writing the same backend-vs-backend position conflicts that
                // caused live-map jitter straight into permanent track history.
                const arbitratedVpStates = vpStates
                    .map(p => masterStateMap.get(p.icao24))
                    .filter(Boolean);
                ingestTrackPoints(arbitratedVpStates, Math.floor(Date.now() / 1000)).catch(() => {});
                logger.debug('SYNC', `Viewport overlay: ${vpStates.length} planes | sources: ${vpSources.join('+')} | ${Math.round(performance.now()-t0)}ms`);
            }
        } catch (e) {
            logger.error('SYNC', `Viewport overlay error: ${e.message}`);
        } finally {
            _viewportGuard.exit();
        }
    }

    // ── Tier 3: Special Categories ─────────────────────────────────────────────
    const _specialGuard = createStuckGuard('fetchSpecialCategories', notifyDiscord);
    async function fetchSpecialCategories() {
        if (_specialGuard.shouldSkip()) return;
        _specialGuard.enter();
        const t0 = performance.now();

        try {
            const [milR, laddR] = await Promise.allSettled([
                cbOpen('al-mil')
                    ? Promise.reject(new Error('CB open'))
                    : fetch('https://api.airplanes.live/v2/mil', {
                          headers: { 'User-Agent': 'AEROSTRAT/11.0' },
                          signal: AbortSignal.timeout(10000),
                      }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),

                cbOpen('al-ladd')
                    ? Promise.reject(new Error('CB open'))
                    : fetch('https://api.airplanes.live/v2/ladd', {
                          headers: { 'User-Agent': 'AEROSTRAT/11.0' },
                          signal: AbortSignal.timeout(10000),
                      }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
            ]);

            let addedCount = 0;
            const labels = [];

            for (const [result, key, label] of [[milR, 'al-mil', 'mil'], [laddR, 'al-ladd', 'ladd']]) {
                if (result.status === 'fulfilled') {
                    const states = (result.value.ac || []).map(p => normalizeAcRecord(p))
                        .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
                    mergeStates(states, 'merge');
                    addedCount += states.length;
                    labels.push(`${label}:${states.length}`);
                    cbReset(key, states.length, Math.round(performance.now() - t0));
                } else {
                    const msg = result.reason?.message || '';
                    if (msg !== 'CB open') cbTrip(key, msg);
                }
            }

            if (addedCount > 0) {
                pruneAndBroadcast();
                logger.info('SYNC', `Special categories: ${addedCount} planes | ${labels.join(', ')} | ${Math.round(performance.now()-t0)}ms`);
            }
        } catch (e) {
            logger.error('SYNC', `Special categories error: ${e.message}`);
        } finally {
            _specialGuard.exit();
        }
    }

    // ── Enrichment + TrackPoint ingestion (called after global baseline) ───────
    // [perf] Per-icao24 cooldown: skip Aircraft upsert if written < 5 min ago and no clients
    const _aircraftWriteCooldown = new Map(); // icao24 → last write timestamp (ms)
    // [MEM-LEAK] Never had its own cleanup — an icao24 that leaves masterStateMap
    // (and is properly reaped everywhere else) stayed in here forever. Swept
    // below on the same 5-minute cadence as the write-cooldown window itself.
    let _lastCooldownSweepAt = 0;
    const COOLDOWN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
    // [2026-09-06 incident] Track-point ingestion silently stopped for ~27h
    // with zero errors logged — was a plain boolean guard with no watchdog,
    // so a stuck lock (never reaching its own finally) skipped every later
    // call forever with zero trace. createStuckGuard replaces the ad-hoc
    // skip-counter this used to have with the same alert+force-clear
    // mechanism the other three pollers now use — see utils/stuckGuard.js
    // and the 2026-09-27 incident (fetchGlobalBaseline stuck 45 minutes).
    const _enrichGuard = createStuckGuard('enrichAndIngest', notifyDiscord);
    async function enrichAndIngest() {
        if (_enrichGuard.shouldSkip()) return;
        _enrichGuard.enter();
        const finalStates = Array.from(masterStateMap.values());

        try {
            // Phase 1: Write-back enriched fields to Aircraft DB
            // [perf] Only upsert if: (a) has clients watching, OR (b) this icao24 hasn't been written in 5 min
            const hasClients = getClientCount() > 0;
            const now = Date.now();
            const WRITE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

            if (now - _lastCooldownSweepAt > COOLDOWN_SWEEP_INTERVAL_MS) {
                _lastCooldownSweepAt = now;
                const liveIds = new Set(finalStates.map(p => p.icao24));
                for (const icao24 of _aircraftWriteCooldown.keys()) {
                    if (!liveIds.has(icao24)) _aircraftWriteCooldown.delete(icao24);
                }
            }

            const writebackOps = finalStates
                .filter(p => {
                    if (!(p.registration || p.operator || p.typecode || p.description)) return false;
                    const lastWrite = _aircraftWriteCooldown.get(p.icao24) || 0;
                    if (!hasClients && now - lastWrite < WRITE_COOLDOWN_MS) return false;
                    _aircraftWriteCooldown.set(p.icao24, now);
                    return true;
                })
                .map(p => {
                    // Defense in depth against the same class of bug this cache
                    // already got polluted by once — never persist a signal-source
                    // label as if it were a typecode, regardless of how p.typecode
                    // ended up set this cycle.
                    const typecode = isValidTypecode(p.typecode) ? p.typecode : null;
                    return {
                        updateOne: {
                            filter: { $or: [{ icao24: p.icao24 }, { hex: p.icao24 }] },
                            update: {
                                $set: Object.fromEntries([
                                    ['icao24', p.icao24], ['hex', p.icao24],
                                    p.registration && ['registration', p.registration],
                                    typecode       && ['typecode',      typecode],
                                    typecode       && ['type_code',     typecode],
                                    p.operator     && ['operator',      p.operator],
                                    p.operator     && ['airline',       p.operator],
                                    p.description  && ['description',   p.description],
                                    p.year         && ['year',          p.year],
                                ].filter(Boolean)),
                            },
                            upsert: true,
                        },
                    };
                });
            if (writebackOps.length > 0) Aircraft.bulkWrite(writebackOps, { ordered: false })
                .catch(err => logger.warn('SYNC', `Aircraft writeback failed: ${err.message}`));

            // Phase 2: Fill missing typecode from Aircraft DB
            const icaoList = finalStates.map(p => p.icao24);
            const [dbMeta, dbReg] = await Promise.all([
                Aircraft.find({ icao24: { $in: icaoList } }, { icao24: 1, typecode: 1 }),
                Aircraft.find(
                    { icao24: { $in: finalStates.filter(p => !p.registration).map(p => p.icao24) } },
                    { icao24: 1, registration: 1, owner: 1, operatorCallsign: 1 }
                ),
            ]);
            const metaMap = new Map(dbMeta.map(m => [m.icao24.toLowerCase(), m.typecode]));
            const regMap  = new Map(dbReg.map(r => [r.icao24.toLowerCase(), r]));

            let enrichedCount = 0;
            finalStates.forEach(p => {
                const k = p.icao24.toLowerCase();
                let tc = isValidTypecode(p.typecode) ? p.typecode : null;
                if (!tc && isValidTypecode(metaMap.get(k))) tc = metaMap.get(k);
                if (!tc && aircraftMetadataIndex?.has(k)) {
                    const idxTc = aircraftMetadataIndex.get(k);
                    if (isValidTypecode(idxTc)) tc = idxTc;
                    if (p.callsign && p.callsign !== 'UNKNOWN') triggerBackgroundResolution(k, p.callsign);
                }
                if (tc) { p.typecode = tc; enrichedCount++; }
                const reg = regMap.get(k);
                if (reg) {
                    if (!p.registration && reg.registration) p.registration = reg.registration;
                    if (!p.operator && (reg.owner || reg.operatorCallsign))
                        p.operator = reg.owner || reg.operatorCallsign;
                }
                // Mictronics has 73%/76%/99.9% operator/model/registration coverage
                // (vs the in-memory AircraftStore's ~4% operator coverage above,
                // which only ever gets populated from the live ADS-B ownOp field).
                // This was previously only queried on a single-plane detail click
                // (getCompleteDetailsInternal) — every plane in the map-wide bbox
                // view showed no airline at all. A lookup here is a local indexed
                // SQLite read (~6μs each; 7,000 planes ≈ 44ms measured), nowhere
                // near expensive enough to justify skipping it map-wide.
                if (!p.operator || !p.model || !isValidTypecode(p.typecode)) {
                    const mict = MictronicsDb.lookup(k);
                    if (mict) {
                        if (!p.operator && mict.operator) p.operator = mict.operator;
                        if (!p.model && mict.model) p.model = mict.model;
                        if (!isValidTypecode(p.typecode) && isValidTypecode(mict.typecode)) p.typecode = mict.typecode;
                    }
                }
            });

            // Phase 3: Ingest TrackPoints
            await ingestTrackPoints(finalStates, Math.floor(Date.now() / 1000));

            if (ingestionStats.totalBatches % 10 === 0 && ingestionStats.totalBatches > 0) {
                logger.info('INGEST', `Cumulative: ${ingestionStats.totalPoints.toLocaleString()} pts | ${ingestionStats.totalBatches} batches | sessions: ${activeSessions.size} active`);
            }

        } catch (e) {
            logger.warn('SYNC', `enrichAndIngest error: ${e.message}`);
        } finally {
            _enrichGuard.exit();
        }
    }

    return { fetchGlobalBaseline, fetchViewportOverlay, fetchSpecialCategories, enrichAndIngest };
}

module.exports = { createPollers };
