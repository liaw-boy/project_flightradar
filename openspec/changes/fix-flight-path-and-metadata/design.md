## Context

The AEROSTRAT map uses a custom `PlaneCanvasLayer` for high-performance aircraft rendering. The current state caused all flying planes to render atmospheric trails, leading to visual chaos. Furthermore, the `Sidebar` component suffered from data gaps and a lack of loading states, leading to "N/A" spam.

## Goals / Non-Goals

**Goals:**
- Eliminate map clutter by restricting flight path trails to the selected aircraft only.
- Implement a robust metadata resolution chain with explicit "Loading..." states.
- Prevent duplicate/overlapping flight path lines using `selectedFlightPathRef.current` logic.
- Fix React initialization errors in the Sidebar component.

**Non-Goals:**
- Modifying backend data ingestion frequencies.

## Decisions

- **Selection-Based Trail Filter**: Added an `isSelected` boolean gate to the `Gradient Trail` block in `MapView.jsx`.
- **Path Priority Gap Filling**: Configured `MapView.jsx` to skip the cyan Bezier spline (`trackStore` rendering) when `selectedFlightPathRef.current` is available.
- **Computed Value Reordering**: Moved metadata-derived constants below `useState` declarations in `Sidebar.jsx` to ensure `registry` is initialized before use.
- **Registration Resolution Chain**: Implemented a chain in `Sidebar.jsx`: `metadata.registration` -> `plane.registration` -> `registry.registration` -> "Loading...".
- **Route UI Loading Logic**: Added `routeLoading` boolean state to show "..." while fetching airport/route data.

## Risks / Trade-offs

- [Risk] Metadata APIs might still return null for obscure aircraft. ?? Mitigation: Fallback to base telemetry and "--" for confirmed missing data.
- [Trade-off] Skipping spline rendering means no animation during the sub-second transition to the session track. ?? Decision: Cleanliness over minor transition animation.
