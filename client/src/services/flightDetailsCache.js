// Shared cache for /api/flight/complete-details results.
// Sidebar writes here after fetch; HoverCard reads first to skip redundant requests.
const TTL_MS  = 3 * 60 * 1000; // 3 minutes
const MAX_SIZE = 200;           // hard cap — evicts oldest entry to prevent memory growth

const _cache = new Map(); // icao24 → { data, ts }

export const flightDetailsCache = {
    get(icao24) {
        const entry = _cache.get(icao24);
        if (!entry) return null;
        if (Date.now() - entry.ts > TTL_MS) { _cache.delete(icao24); return null; }
        return entry.data;
    },
    set(icao24, data) {
        if (_cache.size >= MAX_SIZE) {
            // Evict the oldest entry (Maps preserve insertion order)
            _cache.delete(_cache.keys().next().value);
        }
        _cache.set(icao24, { data, ts: Date.now() });
    },
};
