## ADDED Requirements

### Requirement: Selective Trail Rendering
The system SHALL only render flight path trails for the aircraft that is currently selected by the user.

#### Scenario: No aircraft selected
- **WHEN** the user has not selected any aircraft on the map
- **THEN** no aircraft SHALL display a flight path trail or gradient line.

#### Scenario: Aircraft selected
- **WHEN** the user selects an aircraft via click, search, or URL
- **THEN** the system SHALL render a gradient flight path trail specifically for that aircraft.

#### Scenario: Aircraft deselected
- **WHEN** the user deselects the current aircraft (e.g., by clicking empty space or pressing ESC)
- **THEN** all flight path trails SHALL be removed from the map view.

### Requirement: Priority Session Path Rendering
The system SHALL prioritize the high-quality session flight path over the temporary live track spline to prevent visual overlap.

#### Scenario: Session path available
- **WHEN** a full session flight path is loaded for the selected aircraft (`selectedFlightPathRef.current` has data)
- **THEN** the system SHALL render only the altitude-colored session path and SHALL NOT render the cyan Bezier spline.

#### Scenario: Session path unavailable
- **WHEN** no session flight path is yet loaded for the selected aircraft
- **THEN** the system SHALL fall back to rendering the cyan Bezier spline from the live track buffer.
