'use strict';
// Raw fetchers for the three-tier fusion engine's upstream data sources
// (OpenSky, Airplanes.Live, adsb.fi) plus the shared ADS-B-format
// normalizer. Exposed as a factory rather than free functions because
// accountPool and apiStats must be the exact same instances server.js
// uses elsewhere (account credit tracking / call counters would silently
// split into two untracked copies otherwise).
const path = require('path');
const { Worker } = require('worker_threads');

function createPlaneSources({ accountPool, apiStats, cbOpen, cbTrip, cbReset, logSuppressedSource, logger, backendDir }) {

    async function fetchOpenSky(params = {}) {
        const { headers, account } = await accountPool.getHeaders();
        let url = 'https://opensky-network.org/api/states/all';

        // 構建 BBox 語法
        if (params.lamin !== undefined) {
            url += `?lamin=${params.lamin}&lomin=${params.lomin}&lamax=${params.lamax}&lomax=${params.lomax}`;
        }

        // Was 30s — real-world OpenSky response times of 15-40s meant a single
        // slow call could stall the whole 5s poll loop (this is the fallback
        // of last resort when adsb.lol AND adsb.fi are both already down, so
        // a long stall here shows up as visible "map is stale" gaps). The
        // call-rate throttle (OPENSKY_FALLBACK_MIN_GAP_MS, independent of this
        // value) already caps how often we hit OpenSky, so failing faster
        // here does not burn extra quota — it just stops us waiting as long
        // on a call that was going to fail or arrive too late to matter.
        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(8000)
        });

        accountPool.recordResponse(account, response.status, response.headers);
        apiStats.totalCalls++;

        if (!response.ok) {
            throw new Error(`OpenSky API Error: ${response.status}`);
        }

        const rawJsonText = await response.text();
        return new Promise((resolve, reject) => {
            const worker = new Worker(path.join(backendDir, 'workers', 'parser.js'));
            worker.postMessage(rawJsonText);
            worker.on('message', (msg) => {
                worker.terminate();
                if (msg.success) resolve({ states: msg.planes, time: msg.time });
                else reject(new Error(msg.error));
            });
            worker.on('error', (err) => {
                worker.terminate();
                reject(err);
            });
        });
    }

    // ── OpenSky global baseline fallback ──────────────────────────────────────
    // Last resort for Tier 1: runs only when both adsb.lol and adsb.fi return
    // nothing. OpenSky bills credits per states/all call, so this is throttled
    // independently of the 5s baseline cadence — a multi-minute upstream outage
    // costs a handful of calls, not one every five seconds.
    const OPENSKY_FALLBACK_MIN_GAP_MS = 30_000;
    let _lastOpenSkyFallbackAt = 0;

    // OpenSky's credit cost is a function of bbox area: <=25deg2 => 1 credit,
    // 25-100 => 2, 100-400 => 3, >400 (this includes "no bbox" == whole
    // globe) => 4. Any region actually called "Asia" is already >400deg2, so
    // scoping to Asia would NOT reduce cost below the global rate — this box
    // is deliberately country-sized (Taiwan + Japan/Korea south tip + South
    // China + N. Philippines + Indochina, ~350deg2) to land in the 3-credit
    // tier instead of 4, while still covering the region this site's traffic
    // actually cares about.
    const OPENSKY_FALLBACK_BBOX = { lamin: 17, lamax: 31, lomin: 110, lomax: 135 };

    async function fetchOpenSkyBaselineFallback() {
        if (cbOpen('opensky')) {
            logSuppressedSource('opensky');
            return [];
        }
        const now = Date.now();
        if (now - _lastOpenSkyFallbackAt < OPENSKY_FALLBACK_MIN_GAP_MS) return [];
        _lastOpenSkyFallbackAt = now;

        const t0 = performance.now();
        try {
            const { states } = await fetchOpenSky(OPENSKY_FALLBACK_BBOX);
            const usable = (states || []).filter(
                p => p.icao24 && typeof p.lat === 'number' && typeof p.lng === 'number'
            );
            const ms = Math.round(performance.now() - t0);
            cbReset('opensky', usable.length, ms);
            logger.info('SYNC', `OpenSky fallback engaged: ${usable.length} planes | ${ms}ms`);
            return usable;
        } catch (e) {
            const msg = e?.message || String(e);
            // Quota exhaustion and rate limits both mean "stop asking for a while".
            if (msg.includes('429') || msg.includes('503') || /credit|quota/i.test(msg)) {
                cbTrip('opensky');
            }
            logger.warn('SYNC', `OpenSky fallback failed: ${msg}`);
            return [];
        }
    }

    /**
     * [v10.3] Shared normalizer for all adsb-format sources (adsb.lol, adsb.fi, airplanes.live).
     * All three return the same ADSBexchange v2 compatible format with `ac[]` array.
     * Extra fields (desc, ownOp, year, nav_modes) are passed through for DB write-back.
     */
    // sourceNowMs: the API response's own `now` field (ms). Used to compute the true
    // position timestamp regardless of server-clock drift between sources.
    const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);

    function normalizeAcRecord(p, sourceNowMs) {
        const nowSec = (sourceNowMs != null ? sourceNowMs : Date.now()) / 1000;
        const squawk = p.squawk || null;
        const posTime = p.seen_pos != null ? (nowSec - p.seen_pos) : null;
        return {
            icao24:      p.hex?.toLowerCase(),
            callsign:    (p.flight || '').trim(),
            lng:         p.lon,
            lat:         p.lat,
            altitude:    p.alt_baro === 'ground' ? 0 : (p.alt_baro || p.alt_geom || 0),
            velocity:    p.gs != null ? p.gs * 0.51444 : null,
            // p.track (ground track) is frequently null/0 while taxiing — ADS-B ground
            // track requires movement to compute. Fall back to the aircraft's own
            // true/magnetic heading (from its INS/magnetometer, independent of GPS
            // motion) before giving up and defaulting to 0, which previously made
            // every ground aircraft without a track render facing due north.
            heading:     p.track ?? p.true_heading ?? p.mag_heading ?? 0,
            vRate:       (p.baro_rate || 0) * 0.00508,
            onGround:    p.alt_baro === 'ground' || false,
            squawk,
            // isEmergency and lastContact were never set here, even though the
            // WebSocket delta wire format has always carried both fields — every
            // ADS-B-sourced plane silently sent `undefined` for them, so 7500/
            // 7600/7700 never lit up the emergency indicator on the frontend.
            isEmergency: EMERGENCY_SQUAWKS.has(squawk),
            lastContact: Math.floor(posTime != null ? posTime : nowSec),
            // p.type is the ADS-B *signal source* label (adsb_icao/tisb_other/
            // mlat/...), not an aircraft type — only p.t is ever a real typecode.
            // Falling back to p.type here was writing values like "tisb_other"
            // into the aircraft metadata cache as if they were the model, which
            // then blocked every downstream metadata lookup from ever retrying.
            typecode:    p.t || null,
            registration: p.r || null,
            operator:    p.ownOp || null,
            description: p.desc || null,
            year:        p.year || null,
            navModes:    p.nav_modes || null,
            category:    p.category || null,
            isMil:       !!(p.mil || p.dbFlags === 1),
            // posTime: actual position measurement time (seconds). Derived from the
            // source's own clock to avoid server-clock vs feeder-clock drift issues.
            posTime,
        };
    }

    return { fetchOpenSky, fetchOpenSkyBaselineFallback, normalizeAcRecord, EMERGENCY_SQUAWKS };
}

module.exports = { createPlaneSources };
