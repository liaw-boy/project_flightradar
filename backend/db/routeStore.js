'use strict';
/**
 * RouteStore — replaces Mongoose Route model.
 * node-cache with TTL 24h; callsign is the primary key.
 */
const NodeCache = require('node-cache');

const TTL_SECONDS = 24 * 3600;  // 24 hours
const cache = new NodeCache({ stdTTL: TTL_SECONDS, checkperiod: 600, useClones: false });

function normalizeKey(callsign) {
    return (callsign || '').toUpperCase().trim();
}

function applyUpdate(existing, update) {
    const doc = existing ? { ...existing } : {};
    if (update.$set) Object.assign(doc, update.$set);
    else Object.assign(doc, update);
    doc.lastUpdated = new Date().toISOString();
    doc.updatedAt   = doc.lastUpdated;
    return doc;
}

const RouteStore = {
    async findOne(query) {
        const key = normalizeKey(query?.callsign);
        if (!key) return null;
        return cache.get(key) || null;
    },

    async findOneAndUpdate(filter, update, opts = {}) {
        const key = normalizeKey(filter?.callsign);
        if (!key) return null;
        const existing = cache.get(key) || null;
        const updated  = applyUpdate(existing, update);
        if (!updated.callsign) updated.callsign = key;
        cache.set(key, updated);
        return opts.returnDocument === 'after' ? updated : existing;
    },

    async updateOne(filter, update) {
        const key = normalizeKey(filter?.callsign);
        if (!key) return { modifiedCount: 0 };
        const existing = cache.get(key);
        if (!existing) return { modifiedCount: 0 };
        const updated = applyUpdate(existing, update);
        cache.set(key, updated);
        return { modifiedCount: 1 };
    },

    /** deleteMany({ source: 'spatial_inference' }) — scan & delete matching */
    async deleteMany(filter) {
        if (!filter?.source) return { deletedCount: 0 };
        let deleted = 0;
        for (const key of cache.keys()) {
            const doc = cache.get(key);
            if (doc?.source === filter.source) {
                cache.del(key);
                deleted++;
            }
        }
        return { deletedCount: deleted };
    },

    set(callsign, data) {
        cache.set(normalizeKey(callsign), data);
    },

    get(callsign) {
        return cache.get(normalizeKey(callsign)) || null;
    },

    /** Remove a cached route entirely — used when a new flight session starts */
    invalidate(callsign) {
        cache.del(normalizeKey(callsign));
    },
};

module.exports = RouteStore;
