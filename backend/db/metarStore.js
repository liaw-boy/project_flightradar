'use strict';
/**
 * MetarStore — replaces Mongoose Metar model.
 * node-cache with TTL 2h; icaoId (uppercase) is the primary key.
 * Also maintains an iataId → icaoId index for lookups.
 */
const NodeCache = require('node-cache');

const TTL_SECONDS = 2 * 3600;
const cache     = new NodeCache({ stdTTL: TTL_SECONDS, checkperiod: 600, useClones: false });
const iataIndex = new Map(); // iataId → icaoId

const MetarStore = {
    /** bulkWrite([{ updateOne: { filter: { icaoId }, update: { $set: data } } }]) */
    async bulkWrite(ops) {
        let modified = 0;
        for (const op of ops) {
            if (!op.updateOne) continue;
            const { filter, update } = op.updateOne;
            const icaoId = (filter?.icaoId || '').toUpperCase();
            if (!icaoId) continue;
            const data = update?.$set || update || {};
            data.icaoId = icaoId;
            cache.set(icaoId, data);
            if (data.iataId) iataIndex.set(data.iataId.toUpperCase(), icaoId);
            modified++;
        }
        return { modifiedCount: modified };
    },

    /** findOne({ $or: [{ icaoId }, { iataId }] }) */
    async findOne(query) {
        const conds = query?.$or || [query];
        for (const cond of conds) {
            if (cond.icaoId) {
                const doc = cache.get(cond.icaoId.toUpperCase());
                if (doc) return doc;
            }
            if (cond.iataId) {
                const icao = iataIndex.get(cond.iataId.toUpperCase());
                if (icao) {
                    const doc = cache.get(icao);
                    if (doc) return doc;
                }
            }
        }
        return null;
    },

    /** find({}) — return all */
    async find() {
        return cache.keys().map(k => cache.get(k)).filter(Boolean);
    },
};

module.exports = MetarStore;
