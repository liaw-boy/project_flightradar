'use strict';
// Session lifecycle state machine + track-point persistence for the fusion
// engine. Reads/writes activeSessions, lastStoredPoint, and ingestionStats
// from state/appState directly (safe — none of the three are ever
// reassigned wholesale, only mutated in place).
const { activeSessions, lastStoredPoint, ingestionStats } = require('../state/appState');
const { isRealIcao24 } = require('../utils/planeGuards');

function createTrackIngest({ Route, TrackPoint, FlightSession, broadcastTrackPoint }) {

    /**
     * [Time Series] Helper to ingest raw plane data into SQLite (track_points)
     * Standardizes format, lowercases ICAO24, and filters out corrupted coordinates.
     */
    async function ingestTrackPoints(states, timeUnix) {
        if (!states || states.length === 0) return;

        const timestamp = new Date(timeUnix * 1000);
        const now = Date.now();
        const batchTrackPoints = [];
        const sessionCloseOps = [];   // Batched session close operations
        const sessionCreateDocs = []; // Batched new session documents

        // ── Session thresholds (defined once outside the hot loop) ─────────
        const SESSION_TIMEOUT_MS = 600000;      // 10 minutes (reduced from 20 to free activeSessions memory sooner)
        const GROUND_IDLE_TIMEOUT_MS = 900000;  // 15 minutes
        const GROUND_IDLE_SPEED_KTS = 10;       // knots threshold

        for (const p of states) {
            if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
            // Only registry-resolvable aircraft get sessions and track history.
            // TIS-B/ADS-R targets still render live; they just aren't persisted.
            if (!isRealIcao24(String(p.icao24 || '').toLowerCase())) continue;

            const icao24 = p.icao24.toLowerCase();
            const callsign = (p.callsign || 'N/A').toUpperCase().trim();
            const onGround = !!p.onGround;
            const velocityKts = (p.velocity || 0) * 1.94384; // m/s → knots

            // ── SESSION STATE MACHINE (v7.0 Commercial-Grade) ────────────────
            // Transitions:
            //   1. No prior session           → CREATE
            //   2. Callsign changed (non-N/A) → CLOSE old + CREATE
            //   3. Airborne → Ground          → Update state (same session, plane landed)
            //   4. Ground → Airborne          → CLOSE old + CREATE (new flight leg)
            //   5. Inactive > 20 minutes      → CLOSE old + CREATE (timeout)
            //   6. On ground + callsign swap  → CLOSE old + CREATE (turnaround)
            //   7. Ground idle > 15 min (speed < 10 kts) → CLOSE session (parked)

            let session = activeSessions.get(icao24);
            let needsNewSession = false;
            let closeReason = null;

            if (!session) {
                // Case 1: First sighting
                needsNewSession = true;
            } else if (now - session.lastSeen > SESSION_TIMEOUT_MS) {
                // Case 5: Timeout
                needsNewSession = true;
                closeReason = 'TIMEOUT';
            } else if (onGround && velocityKts < GROUND_IDLE_SPEED_KTS) {
                // Case 7: Ground idle tracking (Parked)
                if (!session.groundIdleSince) {
                    session.groundIdleSince = now;
                } else if (now - session.groundIdleSince > GROUND_IDLE_TIMEOUT_MS) {
                    closeReason = 'COMPLETED';
                    needsNewSession = false;
                    sessionCloseOps.push({
                        updateOne: {
                            filter: { sessionId: session.sessionId },
                            update: { $set: { status: 'COMPLETED', endTime: new Date() } }
                        }
                    });
                    ingestionStats.sessionsClosed++;
                    activeSessions.delete(icao24);
                    session = null;
                }
                if (session) {
                    session.lastSeen = now;
                    session.onGround = true;
                }
            } else if (session.onGround && !onGround) {
                // Case 4: Takeoff? — [v11.0 Protection] Require 3 consecutive airborne points
                session.airborneCounter = (session.airborneCounter || 0) + 1;
                session.groundCounter = 0;
                if (session.airborneCounter >= 3) {
                    needsNewSession = true;
                }
            } else if (session.callsign !== callsign && callsign !== 'N/A') {
                // Case 2 & 6: Callsign changed
                needsNewSession = true;
            } else if (!session.onGround && onGround) {
                // Case 3: Landing? — [v11.0 Protection] Require 3 points onGround AND alt < 1000
                const altitude = p.altitude || 0;
                if (altitude < 1000) {
                    session.groundCounter = (session.groundCounter || 0) + 1;
                    session.airborneCounter = 0;
                    if (session.groundCounter >= 3) {
                        session.onGround = true;
                        session.groundIdleSince = now;
                    }
                } else {
                    session.groundCounter = 0;
                }
                session.lastSeen = now;
            } else {
                // Normal movement — reset counters if staying in same state
                if (onGround) {
                    session.groundCounter = (session.groundCounter || 0) + 1;
                    session.airborneCounter = 0;
                } else {
                    session.airborneCounter = (session.airborneCounter || 0) + 1;
                    session.groundCounter = 0;
                }
                if (session.groundIdleSince) session.groundIdleSince = null;
            }

            if (needsNewSession) {
                // Close old session (batched)
                if (session) {
                    sessionCloseOps.push({
                        updateOne: {
                            filter: { sessionId: session.sessionId },
                            update: { $set: { status: closeReason || 'COMPLETED', endTime: new Date() } }
                        }
                    });
                    ingestionStats.sessionsClosed++;
                }

                // Create new session
                const newSessionId = `${icao24}_${now}_${Math.random().toString(36).slice(2, 6)}`;
                session = { sessionId: newSessionId, callsign, lastSeen: now, startTime: timeUnix, onGround, groundIdleSince: null, groundCounter: 0, airborneCounter: 0 };
                activeSessions.set(icao24, session);

                // Invalidate stale route cache for this callsign so the next sidebar click
                // fetches a fresh route (prevents showing the previous flight's Arrived route).
                if (callsign && callsign !== 'N/A') {
                    Route.invalidate(callsign);
                }

                sessionCreateDocs.push({
                    sessionId: newSessionId,
                    icao24,
                    callsign: callsign !== 'N/A' ? callsign : null,
                    startTime: timestamp,
                    status: 'ACTIVE'
                });
                ingestionStats.sessionsCreated++;
            } else if (session) {
                // Regular update — refresh heartbeat
                session.lastSeen = now;
                session.onGround = onGround;

                // Resolve unknown callsign if now available
                if (session.callsign === 'N/A' && callsign !== 'N/A') {
                    session.callsign = callsign;
                    sessionCloseOps.push({
                        updateOne: {
                            filter: { sessionId: session.sessionId },
                            update: { $set: { callsign } }
                        }
                    });
                }
            }

            // Skip track point if session was closed by ground-idle (no active session)
            if (!session) continue;

            // ── Meaningful-change filter (tar1090-style deduplication) ───────────
            // Only store a new point when position or state has changed significantly.
            // Rules (mirrors tar1090): skip if NONE of these changed since last store:
            //   - lat/lng differ (any movement)
            //   - altitude changed > 60m (~200ft)
            //   - heading changed > 5°
            //   - velocity changed > 5 m/s (~10 kts)
            //   - time since last stored > 60 seconds (heartbeat guarantee)
            const lsp = lastStoredPoint.get(icao24);

            // posTime: actual position measurement time (seconds), computed from the
            // source API's own clock (sourceNow - seen_pos). Falls back to server
            // ingest time if the source didn't provide posTime.
            const posTime = (p.posTime != null) ? p.posTime : timeUnix;

            if (lsp) {
                // [Staleness guard] Skip if this position is more than 10s older than the
                // last point we already stored. Prevents feeder/lol interleaving from writing
                // backwards-in-time positions that create zigzag artifacts on the trail.
                if (lsp.posTs != null && posTime < lsp.posTs - 10) continue;

                // Use L1-norm distance threshold (~55m) instead of exact equality.
                // ADS-B parked aircraft have sub-50m transponder jitter that would
                // pass an exact-equality check and trigger unnecessary writes every 15s.
                const MIN_POS_DEG = 0.0005; // ~55m — below any meaningful flight-phase delta
                const samePos     = Math.abs(p.lat - lsp.lat) + Math.abs(p.lng - lsp.lng) < MIN_POS_DEG;
                const altDelta    = Math.abs((p.altitude || 0) - lsp.altitude);
                const hdgDelta    = Math.min(Math.abs((p.heading || 0) - lsp.heading), 360 - Math.abs((p.heading || 0) - lsp.heading));
                const spdDelta    = Math.abs((p.velocity || 0) - lsp.velocity);
                const timeDelta   = timeUnix - lsp.ts;
                const meaningful  = !samePos || altDelta > 60 || hdgDelta > 5 || spdDelta > 5 || timeDelta > 60;
                if (!meaningful) continue;
            }
            lastStoredPoint.set(icao24, {
                lat: p.lat, lng: p.lng,
                altitude: p.altitude || 0,
                heading: p.heading || 0,
                velocity: p.velocity || 0,
                ts: timeUnix,
                posTs: posTime,  // actual measurement time for future staleness checks
            });

            // Build track point with ALL available telemetry fields
            batchTrackPoints.push({
                sessionId: session.sessionId,
                icao24,
                timestamp,
                lat: p.lat,
                lng: p.lng,
                altitude: (typeof p.altitude === 'number') ? p.altitude : 0,
                geo_altitude: (typeof p.geoAltitude === 'number') ? p.geoAltitude : null,
                velocity: p.velocity || 0,
                heading: p.heading || 0,
                vertical_rate: (typeof p.vRate === 'number') ? p.vRate : null,
                onGround,
                squawk: p.squawk || null,
                callsign: callsign !== 'N/A' ? callsign : null,
            });
        }

        if (batchTrackPoints.length === 0) return;

        const batchStart = performance.now();

        // Fire all DB writes concurrently — non-blocking pipeline
        const writePromises = [];

        // 1. Bulk insert track points (main payload)
        writePromises.push(
            TrackPoint.insertMany(batchTrackPoints, { ordered: false })
                .catch(err => {
                    console.error('[INGEST] TrackPoint write error:', err.message);
                })
        );

        // 2. Bulk session state transitions
        if (sessionCloseOps.length > 0) {
            writePromises.push(
                FlightSession.bulkWrite(sessionCloseOps, { ordered: false })
                    .catch(err => console.error('[INGEST] Session update error:', err.message))
            );
        }

        // 3. Bulk session creation
        if (sessionCreateDocs.length > 0) {
            writePromises.push(
                FlightSession.insertMany(sessionCreateDocs, { ordered: false })
                    .catch(err => console.error('[INGEST] Session create error:', err.message))
            );
        }

        await Promise.all(writePromises);

        // Push new track points to any WS clients that have that plane selected
        for (const tp of batchTrackPoints) {
            broadcastTrackPoint(tp.icao24, [
                timeUnix,       // Unix seconds (integer — tp.timestamp is a Date object)
                tp.lat,
                tp.lng,
                tp.altitude,
                tp.heading,
                tp.velocity
            ]);
        }

        // Update telemetry
        ingestionStats.totalPoints += batchTrackPoints.length;
        ingestionStats.totalBatches++;
        ingestionStats.lastBatchSize = batchTrackPoints.length;
        ingestionStats.lastBatchMs = Math.round(performance.now() - batchStart);
    }

    return { ingestTrackPoints };
}

module.exports = { createTrackIngest };
