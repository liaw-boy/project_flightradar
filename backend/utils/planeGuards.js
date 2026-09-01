'use strict';
// Pure ICAO24/typecode/geo guards shared by the fusion engine and several
// route handlers. No external state — safe to import anywhere.

// '000000' / '000001' / 'ffffff' are unassigned sentinels that misconfigured
// feeders emit — '000001' alone had accumulated 8,149 phantom flight
// sessions, as if one aircraft had flown 8,149 separate legs.
const RESERVED_ICAO24 = new Set(['000000', '000001', 'ffffff']);
const isRealIcao24 = hex =>
    typeof hex === 'string' && /^[0-9a-f]{6}$/.test(hex) && !RESERVED_ICAO24.has(hex);

// adsb.lol (ADSBexchange format) prefixes non-ICAO targets — TIS-B and ADS-R
// ground rebroadcasts — with '~'. They carry no registry-resolvable address,
// so no lookup can ever give them a type, registration or operator. They stay
// on the live map (they are real traffic, ~0.5% of the feed) but are kept out
// of session/track persistence, where they had produced 217k junk sessions.
const isNonIcaoTarget = hex => typeof hex === 'string' && hex.startsWith('~');

// ADS-B "signal source" labels — not aircraft types. These come from the
// `type` field on some feeder formats (as opposed to `t`, the real typecode)
// and previously got written into typecode by mistake (`p.t || p.type`,
// fixed in normalizeAcRecord). The bug is fixed at the point of ingest, but
// polluted values from before the fix still sit in aircraft_cache.json and
// get read back in here via Aircraft.find()/aircraftMetadataIndex — without
// this guard, one bad cached value keeps re-entering masterStateMap and
// getting written straight back out via the Phase 1 writeback below,
// refreshing its timestamp and making it look "current" forever.
const SIGNAL_SOURCE_LABELS = /^(adsb|adsr|tisb|mlat|other|unknown|mode)/i;
const isValidTypecode = tc => typeof tc === 'string' && tc.length > 0 && !SIGNAL_SOURCE_LABELS.test(tc);

// ── Merge helper field list ─────────────────────────────────────────────────
// strategy='upsert': full replacement (Tier 1 global baseline)
// strategy='merge' : keep existing fields, only update non-null new values (Tier 2/3 overlays)
// Positional fields subject to time/plausibility arbitration in stateMerge.js.
// Every other field (squawk, callsign, enrichment, isMil, ...) is always
// allowed to update regardless of position freshness — only the "where is
// it" component gets held back when it's suspect.
const POSITION_FIELDS = ['lat', 'lng', 'heading', 'altitude', 'velocity', 'onGround', 'vRate'];

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function initialBearingDeg(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function angleDiffDeg(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

module.exports = {
    RESERVED_ICAO24, isRealIcao24, isNonIcaoTarget,
    SIGNAL_SOURCE_LABELS, isValidTypecode, POSITION_FIELDS,
    getDistance, initialBearingDeg, angleDiffDeg,
};
