'use strict';
// Shared ADS-B-format normalizer for the three-tier fusion engine's upstream
// data sources (adsb.lol/adsb.fi/airplanes.live — fetched directly in
// server.js/pollers.js).
//
// [2026-09] This used to be a factory (createPlaneSources) taking an
// `accountPool` + apiStats/circuit-breaker dependencies, and also held
// fetchOpenSky/fetchOpenSkyBaselineFallback — removed once OpenSky's API
// went fully dead (metadata endpoint returns 410 Gone; states endpoint
// requires an OAuth2 credential pool that's no longer worth maintaining for
// a dead upstream). normalizeAcRecord never touched any of those
// dependencies, so once OpenSky's functions were gone the factory wrapper
// had nothing left to close over — collapsed to plain exports. See git
// history for the OAuth2 token-rotation + credit-quota implementation if
// OpenSky ever comes back.

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

module.exports = { normalizeAcRecord, EMERGENCY_SQUAWKS };
