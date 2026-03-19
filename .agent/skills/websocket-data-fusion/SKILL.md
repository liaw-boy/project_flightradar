---
name: websocket-data-fusion
description: Use when modifying real-time airplane data flow, handling multiple API sources (ADSB-Fi vs OpenSky), or adjusting the WebSocket delta encoding and spatial filtering logic.
---

# WebSocket Data Fusion

This skill guides the management of real-time flight data flow within the AEROSTRAT system, specifically handling the fusion of multiple data sources and the efficient broadcasting of updates to clients.

## Core Components

### 1. Data Sources (ADSB-Fi & OpenSky)
- **Primary vs Fallback**: The system uses ADSB-Fi as a primary source when available and falls back to OpenSky.
- **Quota Management**: OpenSky accounts are rotated automatically (`rotateAccount()`) to manage rate limits.
- **Tactical Logging**: Log each fetch with latency, source, and plane count. Use the `getTime()` helper.

### 2. Socket Engine (`socketEngine.js`)
- **Delta Encoding**: Only send changed properties (`lat`, `lng`, `heading`, `altitude`, `velocity`, `onGround`, `lastContact`) to save bandwidth.
- **MsgPack**: Use `msgpack-lite` for binary serialization.
- **Spatial Filtering (BBox)**: 
  - Each client connection can have a `ws.bbox`.
  - Only broadcast updates for planes that fall within the client's current viewport.

### 3. SSE (Server-Sent Events)
- Used for lightweight notifications (e.g., global cache updates, anomaly alerts) that trigger the client to fetch non-real-time data.

## Implementation Patterns

### Adding a New Data Property to Broadcast
1. Update the implemention in `server.js` to parse the property.
2. Update `socketEngine.js`:
   - Add the property to the `prevStates` check.
   - Include the property in the `updatesMap` array.
   - Update the index reference in the broadcasting loop.

### Handling Rate Limits (429)
When an API fetch returns a 429, immediately trigger `rotateAccount()` and sync the quota cache.

## Common Mistakes
- **Broadcast Overload**: Sending full state instead of deltas.
- **Stale Cache**: Forgetting to update `prevStates` when a plane is removed.
- **BBox Ignorance**: Not checking `client.bbox` before sending updates.
