'use strict';
/**
 * AircraftStore — replaces Mongoose Aircraft model.
 * Uses node-cache (in-process, TTL 90d) with a JSON file for cold-start persistence.
 * Exposes the same API surface as the Mongoose model (findOne, find, findOneAndUpdate, bulkWrite).
 */
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

const TTL_SECONDS = 90 * 24 * 3600;           // 90 days
const PERSIST_PATH = path.join(__dirname, '..', 'data', 'aircraft_cache.json');
const PERSIST_INTERVAL = 5 * 60 * 1000;        // flush to disk every 5 min

const cache = new NodeCache({ stdTTL: TTL_SECONDS, checkperiod: 3600, useClones: false });

// ── Cold-start: load persisted cache ─────────────────────────────────────
(function loadPersisted() {
    try {
        if (fs.existsSync(PERSIST_PATH)) {
            const raw = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
            let loaded = 0;
            const now = Date.now() / 1000;
            for (const [k, entry] of Object.entries(raw)) {
                if (!entry.expiresAt || entry.expiresAt > now) {
                    cache.set(k, entry.data);
                    loaded++;
                }
            }
            console.log(`[AircraftStore] Loaded ${loaded} aircraft from disk cache`);
        }
    } catch (_) { /* ignore corrupt cache */ }
})();

// ── Persist to disk periodically ────────────────────────────────────────
function persistToDisk() {
    try {
        const keys = cache.keys();
        const out = {};
        for (const k of keys) {
            const val = cache.get(k);
            if (val !== undefined) {
                out[k] = { data: val, expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS };
            }
        }
        const dir = path.dirname(PERSIST_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(PERSIST_PATH, JSON.stringify(out));
    } catch (_) { /* non-fatal */ }
}
setInterval(persistToDisk, PERSIST_INTERVAL);

// ── Helpers ──────────────────────────────────────────────────────────────
function normalizeKey(icao24) {
    return (icao24 || '').toLowerCase().trim();
}

function applyUpdate(existing, update) {
    const doc = existing ? { ...existing } : {};
    if (update.$set) Object.assign(doc, update.$set);
    else Object.assign(doc, update);
    doc.updatedAt = new Date().toISOString();
    return doc;
}

// ── Public API (Mongoose-compatible) ────────────────────────────────────
const AircraftStore = {
    /** findOne({ icao24 }) or findOne({ $or: [{ icao24 }, { hex }] }) */
    async findOne(query) {
        let key = null;
        if (query.icao24)       key = normalizeKey(query.icao24);
        else if (query.hex)     key = normalizeKey(query.hex);
        else if (query.$or) {
            for (const cond of query.$or) {
                const k = normalizeKey(cond.icao24 || cond.hex);
                if (k) { key = k; break; }
            }
        }
        if (!key) return null;
        return cache.get(key) || null;
    },

    /** find({ icao24: { $in: list } }, projection) */
    async find(query, projection) {
        const list = query?.icao24?.$in || query?.hex?.$in || [];
        if (list.length === 0) return [];
        return list
            .map(id => cache.get(normalizeKey(id)))
            .filter(Boolean)
            .map(doc => {
                if (!projection) return doc;
                const out = {};
                for (const k of Object.keys(projection)) {
                    if (projection[k] && k !== '_id') out[k] = doc[k];
                }
                return out;
            });
    },

    /** findOneAndUpdate(filter, update, { upsert, returnDocument }) */
    async findOneAndUpdate(filter, update, opts = {}) {
        let key = null;
        if (filter.icao24)  key = normalizeKey(filter.icao24);
        else if (filter.hex) key = normalizeKey(filter.hex);
        else if (filter.$or) {
            for (const c of filter.$or) {
                const k = normalizeKey(c.icao24 || c.hex);
                if (k) { key = k; break; }
            }
        }
        if (!key) return null;

        const existing = cache.get(key) || null;
        const updated  = applyUpdate(existing, update);
        if (!updated.icao24) updated.icao24 = key;
        if (!updated.hex)    updated.hex    = key;
        cache.set(key, updated);
        return opts.returnDocument === 'after' ? updated : existing;
    },

    /** bulkWrite([{ updateOne: { filter, update, upsert } }]) */
    async bulkWrite(ops) {
        let modified = 0;
        for (const op of ops) {
            if (!op.updateOne) continue;
            const { filter, update } = op.updateOne;
            let key = normalizeKey(filter?.icao24 || filter?.hex);
            if (!key && filter?.$or) {
                for (const c of filter.$or) {
                    const k = normalizeKey(c.icao24 || c.hex);
                    if (k) { key = k; break; }
                }
            }
            if (!key) continue;
            const existing = cache.get(key) || null;
            const updated  = applyUpdate(existing, update);
            if (!updated.icao24) updated.icao24 = key;
            if (!updated.hex)    updated.hex    = key;
            cache.set(key, updated);
            modified++;
        }
        return { modifiedCount: modified };
    },

    /** estimatedDocumentCount() */
    async estimatedDocumentCount() {
        return cache.keys().length;
    },

    /** Direct set by key (internal use) */
    set(icao24, data) {
        cache.set(normalizeKey(icao24), data);
    },

    /** Direct get by key (internal use) */
    get(icao24) {
        return cache.get(normalizeKey(icao24)) || null;
    },
};

module.exports = AircraftStore;
