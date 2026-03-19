---
name: track-data-management
description: Use when working with historical flight paths, flight session persistence (FlightSession model), or merging live tracks with database points.
---

# Track Data Management

This skill covers the logic for handling flight paths, persisting historical data, and managing the state of flight sessions.

## Core Models
- **`FlightSession`**: Tracks the overall flight (ICAO24, Callsign, Start/End time, Status).
- **`TrackPoint`**: Individual time-series points (Lat, Lng, Alt, Vel, Heading) linked to a `sessionId`.

## Session State Machine
The system manages sessions based on airplane signals:
- **NEW**: Created when a new ICAO24 appears or after a long gap (>1 hour).
- **ACTIVE**: Currently receiving live updates.
- **COMPLETED**: Explicitly closed when the plane lands (`onGround: true`) or implicitly timed out.

### Restoration Logic (`restoreActiveSessions`)
On server restart, the system scans the DB for `ACTIVE` sessions and checks their last `TrackPoint`.
- If the last point is within 1 hour, it restores the session to memory.
- Otherwise, it marks the session as `COMPLETED`.

## Data Ingestion
- **Ingestion Guard**: Ensure `mongoose.connection.readyState === 1` before writing.
- **ICAO24 Normalization**: Always use `.toLowerCase()` for ICAO24 identifiers.
- **Batching**: Use `TrackPoint.insertMany(..., { ordered: false })` for performance.

## Merging Logic (Server-side)
When the UI requests a track for an aircraft:
1. Fetch all historical points from the DB for the current `sessionId`.
2. Append any points currently in the live `prevStates` cache.
3. Deduplicate by timestamp and sort chronologically.

## Common Mistakes
- **Session Leak**: Not closing sessions when a plane land/vanish.
- **Duplicate Points**: Ingesting the same timestamp multiple times.
- **Case Inconsistency**: Mixing Upper/Lower case for ICAO24 in queries.
