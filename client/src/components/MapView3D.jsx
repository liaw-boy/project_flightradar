import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { DeckGL } from '@deck.gl/react';
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { Map } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { normalizeLongitude, getAltitudeColor } from '../utils/flightUtils';
import { processTrailPath } from '../utils/trailSpline';

// ── GLB model mapping by aircraft category / typecode ───────────────────────
const MODEL_BASE = '/models/aircraft/';

function resolveModel(typecode, category) {
    const tc = (typecode || '').toUpperCase();

    if (/^H/.test(tc) || category === 'H') return 'helicopter';
    if (/^(GL|DG|AS|LS|SZD)/.test(tc) || category === 'G') return 'glider';
    if (/^(C172|PA28|PA18|C150|C182|C152)/.test(tc)) return 'light-prop';
    if (/^(AT[R567]|DHC[68]|BE1[89]|DH6|IL18|AN2)/.test(tc)) return 'turboprop';
    if (/^(CRJ|E1[357]\d|E170|E175|E190|E195|SF34|DH8|RJ[17])/.test(tc)) return 'regional-jet';
    if (/^(B737|B738|B739|B73[GHQSW])/.test(tc)) return 'b737';
    if (/^(B74[78]|A380|A388)/.test(tc)) return 'widebody-4eng';
    if (/^(B74[0-6]|B74SP)/.test(tc)) return 'widebody-4eng';
    if (/^(B75[0-8]|B76[0-7]|B77[0-9]|B78[0-9]|A33[0-9]|A34[0-9]|A35[0-9])/.test(tc)) return 'widebody-2eng';
    if (/^(A31[0-9]|A32[0-9])/.test(tc)) return 'narrowbody';
    if (/^(GLF|CL6|FA[0-9]|LJ[0-9]|C56|C68|C750|PC12|SR2[02])/.test(tc)) return 'bizjet';
    if (category === 'M' || category === 'B') return 'fighter';
    if (/^(MQ|RQ|PRED)/.test(tc) || category === 'D') return 'drone';

    // Generic widebody vs narrowbody fallback by seat count hint
    return 'generic';
}

const MODEL_URLS = {};
['b737','narrowbody','widebody-2eng','widebody-4eng','regional-jet',
 'turboprop','light-prop','helicopter','bizjet','glider','fighter','drone','generic']
    .forEach(m => { MODEL_URLS[m] = `${MODEL_BASE}${m}.glb`; });

// ── Altitude → render elevation (meters) ────────────────────────────────────
// Deck.gl elevation is in meters. We divide by a visual scale to keep
// aircraft from being absurdly high on a 2D-projected map.
const ALT_SCALE = 0.08; // 35000ft (~10000m) → ~800 visual units

function altToElevation(altM) {
    const a = Number(altM) || 0;
    return Math.max(0, a) * ALT_SCALE;
}

// ── Color helpers ─────────────────────────────────────────────────────────────
function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [
        parseInt(h.slice(0,2),16),
        parseInt(h.slice(2,4),16),
        parseInt(h.slice(4,6),16),
    ];
}

// ── Map style ─────────────────────────────────────────────────────────────────
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// ── Initial view state ────────────────────────────────────────────────────────
const INITIAL_VIEW = {
    longitude: 121.5,
    latitude:  25.0,
    zoom:      6,
    pitch:     50,
    bearing:   0,
};

// ── Main component ────────────────────────────────────────────────────────────
export default function MapView3D({
    planesDict = {},
    selectedIcao24,
    onSelectPlane,
    trackPoints = [],
    colorScheme = 'altitude',
    syncViewport,
}) {
    const [viewState, setViewState] = useState(INITIAL_VIEW);
    const deckRef = useRef(null);
    const syncTimerRef = useRef(null);

    // Notify backend of viewport changes (debounced 800ms)
    const handleViewChange = useCallback(({ viewState: vs }) => {
        setViewState(vs);
        if (syncViewport) {
            clearTimeout(syncTimerRef.current);
            syncTimerRef.current = setTimeout(() => {
                // Convert deck.gl viewState to bbox
                const { longitude, latitude, zoom } = vs;
                const degPerTile = 360 / Math.pow(2, zoom);
                const latRange = degPerTile * 0.8;
                const lngRange = degPerTile * 1.4;
                syncViewport({
                    lamin: latitude  - latRange,
                    lamax: latitude  + latRange,
                    lomin: longitude - lngRange,
                    lomax: longitude + lngRange,
                });
            }, 800);
        }
    }, [syncViewport]);

    // Process planes into array
    const planes = useMemo(() => Object.values(planesDict), [planesDict]);

    // Build trail path for selected plane
    const trailPath = useMemo(() => {
        if (!trackPoints || trackPoints.length < 2) return null;
        const processed = processTrailPath(trackPoints);
        if (!processed || processed.length < 2) return null;

        // Group into segments (gap handling)
        const segments = [];
        let seg = [[processed[0][2], processed[0][1], altToElevation(processed[0][3])]];

        for (let i = 1; i < processed.length; i++) {
            const prev = processed[i - 1];
            const cur  = processed[i];
            const dt   = cur[0] && prev[0] ? cur[0] - prev[0] : 0;

            if (dt > 1800) {
                if (seg.length >= 2) segments.push(seg);
                seg = [];
            }
            seg.push([normalizeLongitude(cur[2]), cur[1], altToElevation(cur[3])]);
        }
        if (seg.length >= 2) segments.push(seg);
        return segments;
    }, [trackPoints]);

    // ── Layers ──────────────────────────────────────────────────────────────
    const layers = useMemo(() => {
        const result = [];

        // ── Trail path layer ───────────────────────────────────────────────
        if (trailPath && trailPath.length > 0) {
            result.push(new PathLayer({
                id: 'trail-3d',
                data: trailPath,
                getPath: d => d,
                getColor: [255, 255, 255, 180],
                getWidth: 2,
                widthUnits: 'pixels',
                pickable: false,
                parameters: { depthTest: false },
            }));
        }

        // ── Aircraft layer ─────────────────────────────────────────────────
        // Group planes by model type for batched ScenegraphLayer
        const modelGroups = {};
        for (const plane of planes) {
            if (!plane.lat || !plane.lng) continue;
            const modelKey = resolveModel(plane._activeTypecode || plane.typecode, plane.category);
            if (!modelGroups[modelKey]) modelGroups[modelKey] = [];
            modelGroups[modelKey].push(plane);
        }

        for (const [modelKey, group] of Object.entries(modelGroups)) {
            result.push(new ScenegraphLayer({
                id: `planes-3d-${modelKey}`,
                data: group,
                scenegraph: MODEL_URLS[modelKey],
                getPosition: p => [
                    normalizeLongitude(p.renderLng ?? p.lng),
                    p.renderLat ?? p.lat,
                    altToElevation(p.altitude),
                ],
                getOrientation: p => {
                    // ScenegraphLayer orientation: [pitch, yaw, roll] in degrees
                    // yaw 0 = East; heading 0 = North → yaw = -(heading - 90)
                    const hdg = p.heading || 0;
                    return [0, -(hdg - 90), 0];
                },
                // sizeScale in meters. ~3000m makes planes visible at zoom 5-8.
                // Users zoomed to zoom 10+ will see large icons — acceptable for a 3D view.
                sizeScale: 3000,
                getColor: p => {
                    if (p.icao24 === selectedIcao24) return [0, 220, 255, 255];
                    if (p.isEmergency) return [255, 80, 80, 255];
                    if (p.onGround) return [150, 150, 150, 200];
                    const hex = getAltitudeColor(p.altitude, p.onGround, p.isEmergency, colorScheme);
                    return [...hexToRgb(hex), 240];
                },
                _lighting: 'flat',
                pickable: true,
                autoHighlight: true,
                highlightColor: [0, 220, 255, 80],
                onClick: ({ object }) => {
                    if (object) onSelectPlane?.(object.icao24);
                },
                updateTriggers: {
                    getPosition: [planesDict],
                    getColor: [selectedIcao24, colorScheme],
                },
            }));
        }

        // ── Selected plane pulse ring ──────────────────────────────────────
        if (selectedIcao24 && planesDict[selectedIcao24]) {
            const sp = planesDict[selectedIcao24];
            result.push(new ScatterplotLayer({
                id: 'selected-ring',
                data: [sp],
                getPosition: p => [
                    normalizeLongitude(p.renderLng ?? p.lng),
                    p.renderLat ?? p.lat,
                    altToElevation(p.altitude),
                ],
                getRadius: 8000,
                radiusUnits: 'meters',
                getColor: [0, 220, 255, 60],
                stroked: true,
                getLineColor: [0, 220, 255, 200],
                getLineWidth: 200,
                lineWidthUnits: 'meters',
                pickable: false,
                parameters: { depthTest: false },
            }));
        }

        return result;
    }, [planes, trailPath, selectedIcao24, colorScheme, planesDict]);

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            <DeckGL
                ref={deckRef}
                viewState={viewState}
                onViewStateChange={handleViewChange}
                controller={{ dragRotate: true, touchRotate: true }}
                layers={layers}
                style={{ position: 'absolute', inset: 0 }}
                getCursor={({ isHovering }) => isHovering ? 'pointer' : 'grab'}
            >
                <Map
                    reuseMaps
                    mapStyle={MAP_STYLE}
                />
            </DeckGL>

            {/* 3D controls hint */}
            <div style={{
                position: 'absolute', bottom: 24, right: 16,
                background: 'rgba(15,17,26,0.8)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8, padding: '6px 12px',
                fontSize: 11, color: 'rgba(255,255,255,0.45)',
                pointerEvents: 'none',
                backdropFilter: 'blur(4px)',
            }}>
                右鍵拖曳 旋轉視角 · 滾輪 縮放
            </div>
        </div>
    );
}
