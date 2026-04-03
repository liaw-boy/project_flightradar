'use strict';
/**
 * TrackStore — replaces Mongoose TrackPoint model.
 * Backed by SQLite (append-only time-series).
 * 48h TTL enforced by sqlite.js pruner.
 */
const db = require('./sqlite');

// ── Prepared statements ──────────────────────────────────────────────────
const stmtInsert = db.prepare(`
    INSERT INTO track_points
        (session_id, icao24, ts, lat, lng, altitude, velocity, heading, vertical_rate, on_ground, squawk)
    VALUES
        (@sessionId, @icao24, @ts, @lat, @lng, @altitude, @velocity, @heading, @verticalRate, @onGround, @squawk)
`);

const stmtLatestBySession = db.prepare(`
    SELECT ts FROM track_points
    WHERE session_id = ?
    ORDER BY ts DESC LIMIT 1
`);

const stmtCountTotal = db.prepare('SELECT COUNT(*) AS cnt FROM track_points');
// Fetch all track points for a single session ordered by time (session-scoped)
const stmtFindBySession = db.prepare(
    'SELECT * FROM track_points WHERE session_id = ? ORDER BY ts ASC'
);

// ── Batch insert (transaction) ────────────────────────────────────────────
const insertBatch = db.transaction((points) => {
    for (const p of points) {
        stmtInsert.run({
            sessionId:    p.sessionId    || p.session_id || '',
            icao24:       p.icao24       || '',
            ts:           p.ts || p.timestamp
                ? (typeof (p.ts || p.timestamp) === 'number'
                    ? (p.ts || p.timestamp)
                    : Math.floor(new Date(p.ts || p.timestamp).getTime() / 1000))
                : Math.floor(Date.now() / 1000),
            lat:          p.lat          ?? null,
            lng:          p.lng          ?? p.lon ?? null,
            altitude:     p.altitude     ?? null,
            velocity:     p.velocity     ?? null,
            heading:      p.heading      ?? null,
            verticalRate: p.vertical_rate ?? p.verticalRate ?? null,
            onGround:     p.onGround     ? 1 : 0,
            squawk:       p.squawk       || null,
        });
    }
});

// ── Public API ────────────────────────────────────────────────────────────
const TrackStore = {
    /** insertMany(docs) */
    async insertMany(docs, _opts) {
        if (!docs || docs.length === 0) return;
        insertBatch(docs);
    },

    /** findOne({ sessionId }, { timestamp: 1 }).sort({ timestamp: -1 }).lean() */
    async findOne(query, _projection) {
        const sid = query?.sessionId;
        if (!sid) return null;
        const row = stmtLatestBySession.get(sid);
        if (!row) return null;
        return { timestamp: new Date(row.ts * 1000), ts: row.ts };
    },

    /**
     * findBySessionId(sessionId)
     * Efficient single-session track retrieval via a prepared statement.
     * This is the primary query path for fetchTracksInternal — never mixes sessions.
     */
    async findBySessionId(sessionId) {
        return stmtFindBySession.all(sessionId).map(r => ({
            sessionId:    r.session_id,
            icao24:       r.icao24,
            timestamp:    new Date(r.ts * 1000),
            lat:          r.lat,
            lng:          r.lng,
            altitude:     r.altitude,
            velocity:     r.velocity,
            heading:      r.heading,
            verticalRate: r.vertical_rate,
            onGround:     !!r.on_ground,
            squawk:       r.squawk,
        }));
    },

    /** find({ sessionId: { $in: [...] } }) for playback */
    async find(query) {
        const ids = query?.sessionId?.$in;
        if (!ids || ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        const stmt = db.prepare(
            `SELECT * FROM track_points WHERE session_id IN (${placeholders}) ORDER BY ts ASC`
        );
        return stmt.all(...ids).map(r => ({
            sessionId:    r.session_id,
            icao24:       r.icao24,
            timestamp:    new Date(r.ts * 1000),
            lat:          r.lat,
            lng:          r.lng,
            altitude:     r.altitude,
            velocity:     r.velocity,
            heading:      r.heading,
            verticalRate: r.vertical_rate,
            onGround:     !!r.on_ground,
            squawk:       r.squawk,
        }));
    },

    /** estimatedDocumentCount() */
    async estimatedDocumentCount() {
        return stmtCountTotal.get().cnt;
    },

    /** aggregate — only point-count pipeline is used */
    async aggregate(pipeline) {
        // Only implementation needed: { $match: { sessionId: { $in: ids } } }, { $group: ... }
        const match = pipeline.find(s => s.$match)?.$match;
        const ids   = match?.sessionId?.$in;
        if (!ids || ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        const stmt = db.prepare(
            `SELECT session_id, COUNT(*) AS count FROM track_points WHERE session_id IN (${placeholders}) GROUP BY session_id`
        );
        return stmt.all(...ids).map(r => ({ _id: r.session_id, count: r.count }));
    },
};

module.exports = TrackStore;
