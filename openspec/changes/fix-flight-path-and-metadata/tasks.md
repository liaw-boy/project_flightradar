## 1. Flight Path Rendering (MapView.jsx)

- [x] 1.1 Add `isSelected` check to the Gradient Trail rendering condition.
- [x] 1.2 Implement priority logic to skip Bezier splines when `selectedFlightPath` is active.
- [x] 1.3 Verify that trails only appear for the selected plane and do not overlap.

## 2. Aircraft Metadata & UI (Sidebar.jsx)

- [x] 2.1 Reorder component logic: move computed metadata values after `useState` declarations.
- [x] 2.2 Implement the multi-tier registration resolution chain (Loading -> Metadata -> Plane -> Registry -> "--").
- [x] 2.3 Add loading indicators ("...") for Route IATA codes and city names.
- [x] 2.4 Update UI labels to use the refined `displayRegistration` and `aircraftModel`.

## 3. Verification

- [x] 3.1 Verify map is clean when no plane is selected.
- [x] 3.2 Verify sidebar shows "Loading..." during registry fetch and "..." during route fetch.
- [x] 3.3 Verify 60FPS performance remains stable during flight path transitions.
