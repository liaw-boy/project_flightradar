## Why

Flight paths were rendering behind *all* flying aircraft simultaneously, leading to significant visual clutter on the map. Additionally, aircraft metadata (registration, model, typecode) frequently displayed as "N/A" during loading or for aircraft not present in the OpenSky database. These issues degraded both map clarity and the usefulness of aircraft identification.

## What Changes

- **Selective Path Rendering**: Modified `MapView.jsx` to render trails only for the selected aircraft.
- **Path Priority Rendering**: Optimized the map rendering pipeline to prioritize the altitude-colored session path over the cyan Bezier spline, preventing duplicate overlapping lines.
- **Registration Resolution Chain**: Refined `Sidebar.jsx` to resolve registration using a priority chain: Metadata -> Plane Telemetry -> Registry API -> "Loading..." status. No more immediate "N/A" for missing data.
- **Route Loading States**: Added "..." indicators for IATA codes and city names during active route fetches to improve UI feedback.

## Capabilities

### New Capabilities
- `selective-path-rendering`: Maintains map clarity by rendering flight paths only for explicitly selected aircraft.
- `aircraft-identity-fallback`: Maximizes metadata completeness using a multi-source fallback system (Metadata, Registry API, and WebSocket Telemetry).

### Modified Capabilities
<!-- No requirement changes to existing official specs as they were empty -->

## Impact

- **Frontend Components**: `MapView.jsx` (rendering logic), `Sidebar.jsx` (data resolution, loading states).
- **User Experience**: Drastically cleaner map interface; more reliable aircraft identification and better loading feedback.
