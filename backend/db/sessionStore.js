'use strict';
/**
 * SessionStore — replaces Mongoose FlightSession model.
 * Backed by SQLite (WAL mode) for persistent session history.
 * Exposes same API surface as Mongoose model.
 */
const db = require('./sqlite');

// ── Prepared statements ──────────────────────────────────────────────────
const stmtInsert = db.prepare(`
    INSERT OR IGNORE INTO flight_sessions
        (session_id, icao24, callsign, status, start_time, end_time,
         departure_airport, arrival_airport, created_at, updated_at)
    VALUES
        (@sessionId, @icao24, @callsign, @status, @startTime, @endTime,
         @departureAirport, @arrivalAirport, @createdAt, @updatedAt)
`);

const stmtUpdate = db.prepare(`
    UPDATE flight_sessions
    SET status = @status,
        callsign = COALESCE(@callsign, callsign),
        end_time = @endTime,
        departure_airport = COALESCE(@departureAirport, departure_airport),
        arrival_airport   = COALESCE(@arrivalAirport, arrival_airport),
        updated_at = @updatedAt
    WHERE session_id = @sessionId
`);

const stmtFindById = db.prepare(
    'SELECT * FROM flight_sessions WHERE session_id = ?'
);
const stmtFindActive = db.prepare(
    "SELECT * FROM flight_sessions WHERE status = 'ACTIVE'"
);
const stmtUpdateMany = db.prepare(`
    UPDATE flight_sessions
    SET status = @status, end_time = @endTime, updated_at = @updatedAt
    WHERE status = 'ACTIVE' AND updated_at < @cutoff
`);
const stmtCount = db.prepare(
    "SELECT COUNT(*) AS cnt FROM flight_sessions WHERE status = 'ACTIVE'"
);

// ── Row ↔ doc conversion ──────────────────────────────────────────────────
function rowToDoc(row) {
    if (!row) return null;
    return {
        sessionId:        row.session_id,
        icao24:           row.icao24,
        callsign:         row.callsign,
        status:           row.status,
        startTime:        row.start_time   ? new Date(row.start_time   * 1000) : null,
        endTime:          row.end_time     ? new Date(row.end_time     * 1000) : null,
        departureAirport: row.departure_airport,
        arrivalAirport:   row.arrival_airport,
        createdAt:        row.created_at   ? new Date(row.created_at   * 1000) : null,
        updatedAt:        row.updated_at   ? new Date(row.updated_at   * 1000) : null,
    };
}

function docToRow(doc) {
    const now = Math.floor(Date.now() / 1000);
    return {
        sessionId:        doc.sessionId || doc.session_id || '',
        icao24:           doc.icao24 || '',
        callsign:         doc.callsign || null,
        status:           doc.status || 'ACTIVE',
        startTime:        doc.startTime ? Math.floor(new Date(doc.startTime).getTime() / 1000) : now,
        endTime:          doc.endTime   ? Math.floor(new Date(doc.endTime).getTime() / 1000)   : null,
        departureAirport: doc.departureAirport || null,
        arrivalAirport:   doc.arrivalAirport   || null,
        createdAt:        now,
        updatedAt:        now,
    };
}

// ── Batch helpers ─────────────────────────────────────────────────────────
const insertMany = db.transaction((docs) => {
    for (const doc of docs) stmtInsert.run(docToRow(doc));
});

const bulkUpdateSessions = db.transaction((ops) => {
    const now = Math.floor(Date.now() / 1000);
    for (const op of ops) {
        if (!op.updateOne) continue;
        const { filter, update } = op.updateOne;
        const sessionId = filter?.sessionId;
        if (!sessionId) continue;
        const $set = update?.$set || {};
        stmtUpdate.run({
            sessionId,
            status:           $set.status           || null,
            callsign:         $set.callsign          || null,
            endTime:          $set.endTime ? Math.floor(new Date($set.endTime).getTime() / 1000) : null,
            departureAirport: $set.departureAirport  || null,
            arrivalAirport:   $set.arrivalAirport    || null,
            updatedAt:        now,
        });
    }
});

// ── Public API ────────────────────────────────────────────────────────────
const SessionStore = {
    /** find({ status: 'ACTIVE' }) */
    async find(query) {
        if (query?.status === 'ACTIVE') {
            return stmtFindActive.all().map(rowToDoc);
        }
        // sessionId $in query
        if (query?.sessionId?.$in) {
            const stmt = db.prepare(
                `SELECT * FROM flight_sessions WHERE session_id IN (${query.sessionId.$in.map(() => '?').join(',')})`
            );
            return stmt.all(...query.sessionId.$in).map(rowToDoc);
        }
        return [];
    },

    /** findOne({ sessionId }) */
    async findOne(query) {
        const id = query?.sessionId;
        if (!id) return null;
        return rowToDoc(stmtFindById.get(id));
    },

    /** insertMany(docs) */
    async insertMany(docs) {
        if (!docs || docs.length === 0) return;
        insertMany(docs);
    },

    /** bulkWrite(ops) */
    async bulkWrite(ops) {
        if (!ops || ops.length === 0) return { modifiedCount: 0 };
        bulkUpdateSessions(ops);
        return { modifiedCount: ops.length };
    },

    /** updateMany({ status: 'ACTIVE', updatedAt: { $lt: cutoff } }, { $set: { status, endTime } }) */
    async updateMany(filter, update) {
        const cutoff = filter?.updatedAt?.$lt
            ? Math.floor(new Date(filter.updatedAt.$lt).getTime() / 1000)
            : 0;
        const $set = update?.$set || {};
        const now = Math.floor(Date.now() / 1000);
        const info = stmtUpdateMany.run({
            status:   $set.status || 'TIMEOUT',
            endTime:  $set.endTime ? Math.floor(new Date($set.endTime).getTime() / 1000) : now,
            updatedAt: now,
            cutoff,
        });
        return { modifiedCount: info.changes };
    },

    /** estimatedDocumentCount() for stats */
    async estimatedDocumentCount() {
        return stmtCount.get().cnt;
    },
};

module.exports = SessionStore;
