'use strict';
/**
 * PredictionLogStore — records "what the model predicted 2s ago" vs "what
 * the aircraft's next real position update actually was". Feeds
 * ml_trajectory/retrain_and_promote.py's error-weighted resampling; see
 * services/broadcastEngine.js for where a row gets produced.
 */
const db = require('./sqlite');

const stmtInsert = db.prepare(`
    INSERT INTO prediction_log
        (icao24, ts, predicted_lat, predicted_lng, predicted_altitude, actual_lat, actual_lng, actual_altitude, error_km, steps_ahead)
    VALUES
        (@icao24, @ts, @predictedLat, @predictedLng, @predictedAltitude, @actualLat, @actualLng, @actualAltitude, @errorKm, @stepsAhead)
`);

const insertBatch = db.transaction((rows) => {
    for (const r of rows) stmtInsert.run(r);
});

module.exports = {
    insertMany(rows) {
        if (!rows || rows.length === 0) return;
        insertBatch(rows);
    },
};
