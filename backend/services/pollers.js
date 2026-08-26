'use strict';
// [v11.0] Three-Tier Polling Engine — Tier 1 (global baseline), Tier 2
// (viewport overlay), Tier 3 (special categories: military/LADD), plus
// enrichAndIngest (typecode/operator/model enrichment + TrackPoint write).
//
// normalizeAcRecord/fetchOpenSkyBaselineFallback and ingestTrackPoints are
// factory-injected rather than required directly: both are produced by
// server.js's createPlaneSources()/createTrackIngest() calls, which close
// over accountPool/apiStats and Route/TrackPoint/FlightSession/
// broadcastTrackPoint respectively — re-requiring those factories here
// would construct a second, unsynced set of instances. triggerBackgroundResolution
// is likewise a plain function living in server.js's module scope (its own
// pendingResolutions Set), not something requirable on its own.
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

function createPollers({ normalizeAcRecord, fetchOpenSkyBaselineFallback, ingestTrackPoints, triggerBackgroundResolution }) {

    // ── Tier 1: Global Baseline ────────────────────────────────────────────────
    // Primary: adsb.lol (no quota, 5s interval)
    // Fallback: adsb.fi snapshot (if adsb.lol fails)
    let _baselineRunning = false;

    // A single failed cycle (one source hiccup) is normal and already handled by
    // the per-source circuit breakers. This tracks the harder failure: adsb.lol,
    // adsb.fi-snap, AND the OpenSky fallback all empty in the same cycle — the
    // whole tier is dark, not just one upstream. Escalates to an ERROR-level,
    // throttled alert once that's been true for several consecutive cycles, so
    // it's visible without a human having to notice the map went stale.
    let _consecutiveTotalOutageCycles = 0;
    const TOTAL_OUTAGE_ALERT_THRESHOLD = 3;       // ~15s of zero data at the 5s poll interval
    const TOTAL_OUTAGE_ALERT_THROTTLE_MS = 5 * 60_000; // re-announce at most once per 5 min while it persists
    let _lastTotalOutageAlertAt = 0;

    async function fetchGlobalBaseline() {
        if (_baselineRunning) return;
        _baselineRunning = true;
        const t0 = performance.now();

        try {
            // Both sources fire in parallel every cycle — hot standby.
            // adsb.lol is preferred; adsb.fi data is ready immediately if lol fails,
            // with zero additional delay (no sequential fallback gap).
            const [lolR, fiR] = await Promise.allSettled([
                cbOpen('adsb.lol')
                    ? Promise.reject(new Error('CB open'))
                    : fetch('https://api.adsb.lol/v2/lat/0/lon/0/dist/99999', {
                          headers: { 'User-Agent': 'AEROSTRAT/12.0' },
                          signal: AbortSignal.timeout(8000),
                      }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),

                cbOpen('adsb.fi-snap')
                    ? Promise.reject(new Error('CB open'))
                    : fetch('https://opendata.adsb.fi/api/v2/snapshot', {
                          headers: { 'User-Agent': 'AEROSTRAT/12.0' },
                          signal: AbortSignal.timeout(10000),
                      }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
            ]);

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
                    if (msg.includes('429') || msg.includes('503')) cbTrip('adsb.lol');
                    logger.warn('SYNC', `adsb.lol failed: ${msg}`);
                }
            }

            if (fiR.status === 'fulfilled') {
                fiStates = (fiR.value.ac || []).map(p => normalizeAcRecord(p, fiR.value.now))
                    .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
                cbReset('adsb.fi-snap', fiStates.length, Math.round(performance.now() - t0));
            } else {
                const msg = fiR.reason?.message || '';
                if (msg === 'CB open') logSuppressedSource('adsb.fi-snap');
                else {
                    if (msg.includes('403')) cbTrip('adsb.fi-snap', 60 * 60_000);
                    else if (msg.includes('429')) cbTrip('adsb.fi-snap');
                    logger.warn('SYNC', `adsb.fi-snap failed: ${msg}`);
                }
            }

            // Prefer adsb.lol; fall back to adsb.fi instantly (data already fetched)
            let states = lolStates.length > 0 ? lolStates : fiStates;
            let source = lolStates.length > 0 ? 'adsb.lol' : (fiStates.length > 0 ? 'adsb.fi-snap' : '');

            // Tier 1c: both ADS-B aggregators came back empty — fall back to OpenSky.
            // Credit-metered, so it throttles itself rather than following the 5s loop.
            if (states.length === 0) {
                const osStates = await fetchOpenSkyBaselineFallback();
                if (osStates.length > 0) {
                    states = osStates;
                    source = 'opensky';
                }
            }

            if (states.length === 0) {
                logger.warn('SYNC', 'Global baseline: all sources failed — using stale cache');
                getGlobalPlanesCache().stale = true;

                _consecutiveTotalOutageCycles++;
                if (_consecutiveTotalOutageCycles >= TOTAL_OUTAGE_ALERT_THRESHOLD) {
                    const now = Date.now();
                    if (now - _lastTotalOutageAlertAt >= TOTAL_OUTAGE_ALERT_THROTTLE_MS) {
                        _lastTotalOutageAlertAt = now;
                        const outageSec = _consecutiveTotalOutageCycles * 5;
                        logger.error('ALERT', `Global baseline dark for ${outageSec}s+ — adsb.lol, adsb.fi-snap, AND OpenSky fallback all failed this cycle. Map is serving stale data.`);
                    }
                }
                return;
            }
            _consecutiveTotalOutageCycles = 0;

            // OpenSky carries no typecode/registration/operator — merge so the
            // enrichment already collected from adsb.lol survives the outage.
            mergeStates(states, source === 'opensky' ? 'merge' : 'upsert');
            pruneAndBroadcast();
            logger.info('SYNC', `✅ Global baseline: ${states.length} planes | source: ${source} | ${Math.round(performance.now()-t0)}ms`);

            await enrichAndIngest();

        } catch (e) {
            logger.error('SYNC', `Global baseline error: ${e.message}`);
            getGlobalPlanesCache().stale = true;
        } finally {
            _baselineRunning = false;
        }
    }

    // ── Tier 2: Viewport Overlay ───────────────────────────────────────────────
    let _viewportRunning = false;
    async function fetchViewportOverlay() {
        if (_viewportRunning) return;
        _viewportRunning = true;
        const t0 = performance.now();

        try {
            const viewports = getActiveViewports();
            const vp = viewports.length > 0 ? viewports[0] : null;
            if (!vp) return; // No active clients — skip viewport fetch to save bandwidth & CPU
            const lat = ((vp.lamin + vp.lamax) / 2).toFixed(4);
            const lon = ((vp.lomin + vp.lomax) / 2).toFixed(4);

            // Parallel: airplanes.live /point + re-api
            const [alR, reR] = await Promise.allSettled([
                cbOpen('al-point')
                    ? Promise.reject(new Error('CB open'))
                    : fetch(`https://api.airplanes.live/v2/point/${lat}/${lon}/250`, {
                          headers: { 'User-Agent': 'AEROSTRAT/11.0' },
                          signal: AbortSignal.timeout(8000),
                      }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),

                cbOpen('re-api')
                    ? Promise.reject(new Error('CB open'))
                    : fetch(`https://re-api.adsb.lol?circle=${lat},${lon},500`, {
                          headers: { 'User-Agent': 'AEROSTRAT/11.0' },
                          signal: AbortSignal.timeout(8000),
                      }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))),
            ]);

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
                if (msg.includes('429')) cbTrip('al-point');
            }

            if (reR.status === 'fulfilled') {
                // re-api uses "aircraft" key (readsb native)
                const states = (reR.value.aircraft || []).map(p => normalizeAcRecord(p, reR.value.now))
                    .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
                vpStates = vpStates.concat(states);
                vpSources.push('re-api');
                cbReset('re-api', states.length, Math.round(performance.now() - t0));
            } else {
                const msg = reR.reason?.message || '';
                if (msg.includes('429') || msg.includes('403')) cbTrip('re-api');
            }

            // Fallback: adsb.fi v3 if both AL and re-api failed
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
                    if (e.message.includes('403')) cbTrip('adsb.fi-v3', 60 * 60_000);
                    else if (e.message.includes('429')) cbTrip('adsb.fi-v3');
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
            _viewportRunning = false;
        }
    }

    // ── Tier 3: Special Categories ─────────────────────────────────────────────
    let _specialRunning = false;
    async function fetchSpecialCategories() {
        if (_specialRunning) return;
        _specialRunning = true;
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
                    if (msg.includes('429')) cbTrip(key);
                }
            }

            if (addedCount > 0) {
                pruneAndBroadcast();
                logger.info('SYNC', `Special categories: ${addedCount} planes | ${labels.join(', ')} | ${Math.round(performance.now()-t0)}ms`);
            }
        } catch (e) {
            logger.error('SYNC', `Special categories error: ${e.message}`);
        } finally {
            _specialRunning = false;
        }
    }

    // ── Enrichment + TrackPoint ingestion (called after global baseline) ───────
    let _enrichRunning = false;
    // [perf] Per-icao24 cooldown: skip Aircraft upsert if written < 5 min ago and no clients
    const _aircraftWriteCooldown = new Map(); // icao24 → last write timestamp (ms)
    async function enrichAndIngest() {
        if (_enrichRunning) return;
        _enrichRunning = true;
        const finalStates = Array.from(masterStateMap.values());

        try {
            // Phase 1: Write-back enriched fields to Aircraft DB
            // [perf] Only upsert if: (a) has clients watching, OR (b) this icao24 hasn't been written in 5 min
            const hasClients = getClientCount() > 0;
            const now = Date.now();
            const WRITE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
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
            _enrichRunning = false;
        }
    }

    return { fetchGlobalBaseline, fetchViewportOverlay, fetchSpecialCategories, enrichAndIngest };
}

module.exports = { createPollers };
