## ADDED Requirements

### Requirement: Multi-Source Metadata Resolution
The system SHALL resolve aircraft identity fields (Registration, Model, Typecode) using a prioritized chain of data sources (OpenSky Metadata -> AeroDataBox Registry -> WebSocket Telemetry).

#### Scenario: Registration resolution chain
- **WHEN** resolving the aircraft registration
- **THEN** the system SHALL follow the priority: `metadata.registration` -> `plane.registration` -> `registry.registration`.

#### Scenario: Route loading indicators
- **WHEN** a flight route is being fetched from the API
- **THEN** the system SHALL display "..." for IATA codes and city names to indicate a loading state.

#### Scenario: Metadata not found
- **WHEN** after all fetches are complete and no registration is found
- **THEN** the system SHALL display "--" instead of "N/A".

### Requirement: Initialization Guard
The system SHALL ensure all computed metadata values are initialized after component state is established to prevent runtime errors.

#### Scenario: Component mount
- **WHEN** the Sidebar component mounts and state is initialized
- **THEN** all computed identity fields SHALL be resolved without throwing a ReferenceError.
