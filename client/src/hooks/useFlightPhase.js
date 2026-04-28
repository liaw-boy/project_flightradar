import { useEffect, useRef } from 'react';
import { logger } from '../utils/logger';

/**
 * Flight phase state machine for a selected aircraft.
 * Detects takeoff/landing cycle and fires onFlightComplete when the plane parks
 * for ≥30 s after having been airborne.
 *
 * Extracted from App.jsx to reduce God-component surface area.
 */
export function useFlightPhase({ selectedIcao24, planesDict, trackPointsLength, onFlightComplete }) {
    const stateRef = useRef({ phase: 'UNKNOWN', hasBeenAirborne: false, parkedSince: null });

    // Reset FSM whenever a new plane is selected
    useEffect(() => {
        stateRef.current = { phase: 'UNKNOWN', hasBeenAirborne: false, parkedSince: null };
    }, [selectedIcao24]);

    useEffect(() => {
        if (!selectedIcao24 || trackPointsLength === 0) return;
        const plane = planesDict[selectedIcao24];
        if (!plane) return;

        const kts      = (plane.velocity ?? 0) * 1.944;
        const vRate    = plane.vRate   ?? 0;
        const alt      = plane.altitude ?? 0;
        const onGround = !!plane.onGround;
        const state    = stateRef.current;

        let phase;
        if (onGround) {
            if      (kts > 80) phase = 'TAKEOFF_ROLL';
            else if (kts > 5)  phase = 'LANDING_ROLL';
            else               phase = 'PARKED';
        } else {
            if      (vRate > 1.52)                 phase = 'CLIMBING';
            else if (vRate < -1.02 && alt <= 1500) phase = 'APPROACH';
            else if (vRate < -1.52 && alt >  1500) phase = 'DESCENDING';
            else                                   phase = 'CRUISE';
        }

        if (['CLIMBING', 'CRUISE', 'DESCENDING'].includes(phase)) state.hasBeenAirborne = true;
        if (phase === 'TAKEOFF_ROLL') state.parkedSince = null;  // touch-and-go guard
        if (phase === 'PARKED') {
            if (!state.parkedSince) state.parkedSince = Date.now();
        } else {
            state.parkedSince = null;
        }
        state.phase = phase;

        if (
            state.hasBeenAirborne &&
            phase === 'PARKED' &&
            state.parkedSince &&
            Date.now() - state.parkedSince >= 30_000
        ) {
            logger.info('UI', `Flight completed (${phase}): ${plane.callsign || selectedIcao24} — clearing trail`);
            onFlightComplete();
            state.hasBeenAirborne = false;
            state.parkedSince = null;
        }
    }, [planesDict, selectedIcao24, trackPointsLength]); // eslint-disable-line react-hooks/exhaustive-deps

    return stateRef;
}
