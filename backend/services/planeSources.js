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

        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(30000)
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
            const { states } = await fetchOpenSky();
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

    /**
     * [v10.1] New Primary Telemetry: Airplanes.Live (Multi-Endpoint Support)
     * Supports 'mil', 'point', and 'all' types. Capped at 1 QPS.
     */
    async function fetchAirplanesLive(type = 'all', params = {}) {
        let url = `https://api.airplanes.live/v2/${type}`;
        if (type === 'point' && params.lat && params.lon) {
            url = `https://api.airplanes.live/v2/point/${params.lat}/${params.lon}/${params.dist || 250}`;
        }

        const response = await fetch(url, {
            headers: { 'User-Agent': 'AEROSTRAT/10.1 (Hybrid Sync Engine)' },
            signal: AbortSignal.timeout(10000)
        });

        apiStats.totalCalls++;

        if (!response.ok) {
            throw new Error(`Airplanes.Live ${type} Error: ${response.status}`);
        }

        const data = await response.json();
        // API returns ac[] (ADSBexchange v2 format), not aircraft[]
        const standardStates = (data.ac || []).map(p => normalizeAcRecord(p))
            .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');

        return { states: standardStates, time: Math.floor(data.now || Date.now() / 1000) };
    }

    /**
     * adsb.fi open data API — ADSBexchange v2 compatible, no auth required.
     * Public rate limit: 1 req/sec. Used as fallback when Airplanes.Live fails.
     */
    async function fetchAdsbFi(lat, lon, dist = 250) {
        const response = await fetch(
            `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`,
            { headers: { 'User-Agent': 'AEROSTRAT/5.0' }, signal: AbortSignal.timeout(8000) }
        );
        if (!response.ok) throw new Error(`adsb.fi Error: ${response.status}`);
        const data = await response.json();
        // API returns ac[] (ADSBexchange v2 format), not aircraft[]
        const standardStates = (data.ac || []).map(p => normalizeAcRecord(p))
            .filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');
        return { states: standardStates };
    }

    return { fetchOpenSky, fetchOpenSkyBaselineFallback, normalizeAcRecord, fetchAirplanesLive, fetchAdsbFi, EMERGENCY_SQUAWKS };
}

module.exports = { createPlaneSources };
