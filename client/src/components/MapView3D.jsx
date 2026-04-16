import React, { useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { setWorkerUrl } from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { MapView } from '@deck.gl/core';
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { normalizeLongitude, getAltitudeColor } from '../utils/flightUtils';
import { processTrailPath } from '../utils/trailSpline';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl('/maplibre-gl-csp-worker.js');

// ── Map styles (mirrors 2D mapLayer setting) ──────────────────────────────────
const GL_STYLES = {
    dark:      'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    street:    'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    satellite: {
        version: 8, sources: { sat: { type: 'raster', tileSize: 256,
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] } },
        layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
    },
    terrain: {
        version: 8, sources: { terrain: { type: 'raster', tileSize: 256,
            tiles: ['https://stamen-tiles-a.a.ssl.fastly.net/terrain/{z}/{x}/{y}.jpg'] } },
        layers: [{ id: 'terrain', type: 'raster', source: 'terrain' }],
    },
};
function getMapStyle(layerId) { return GL_STYLES[layerId] ?? GL_STYLES.dark; }

// ── Aircraft model URLs ───────────────────────────────────────────────────────
const MODEL_BASE = '/models/aircraft/';
const MODEL_KEYS = ['b737','narrowbody','widebody-2eng','widebody-4eng','regional-jet',
                    'turboprop','light-prop','helicopter','bizjet','glider','fighter','drone','generic'];
const MODEL_URLS = Object.fromEntries(MODEL_KEYS.map(m => [m, `${MODEL_BASE}${m}.glb`]));

// Per-model yaw offsets (from aeris aircraft-model-calibration.ts)
// Formula: yaw = yawOffset - heading
const MODEL_YAW_OFFSET = {
    'b737':          0,
    'narrowbody':   90,
    'widebody-2eng':180,
    'widebody-4eng':180,
    'regional-jet': 90,
    'turboprop':    90,
    'light-prop':   90,
    'helicopter':   90,
    'bizjet':       90,
    'glider':       90,
    'fighter':       0,
    'drone':        90,
    'generic':      90,
};

function resolveModel(typecode, category) {
    const tc = (typecode || '').toUpperCase();
    if (/^H/.test(tc) || category === 'H') return 'helicopter';
    if (/^(GL|DG|AS|LS|SZD)/.test(tc) || category === 'G') return 'glider';
    if (/^(C172|PA28|PA18|C150|C182|C152)/.test(tc)) return 'light-prop';
    if (/^(AT[R567]|DHC[68]|BE1[89]|DH6|IL18|AN2)/.test(tc)) return 'turboprop';
    if (/^(CRJ|E1[357]\d|E170|E175|E190|E195|SF34|DH8|RJ[17])/.test(tc)) return 'regional-jet';
    if (/^(B737|B738|B739|B73[GHQSW])/.test(tc)) return 'b737';
    if (/^(B74[78]|A380|A388)/.test(tc)) return 'widebody-4eng';
    if (/^(B75[0-8]|B76[0-7]|B77[0-9]|B78[0-9]|A33[0-9]|A34[0-9]|A35[0-9])/.test(tc)) return 'widebody-2eng';
    if (/^(A31[0-9]|A32[0-9])/.test(tc)) return 'narrowbody';
    if (/^(GLF|CL6|FA[0-9]|LJ[0-9]|C56|C68|C750|PC12|SR2[02])/.test(tc)) return 'bizjet';
    if (category === 'M' || category === 'B') return 'fighter';
    if (/^(MQ|RQ|PRED)/.test(tc) || category === 'D') return 'drone';
    return 'generic';
}

// ── Altitude → visual elevation ───────────────────────────────────────────────
// Linear 0.12x scale keeps all aircraft within viewport at pitch 55°.
// cruise at 12000m → 1440m visual, 45000ft/13700m → 1644m visual
function altToElev(altM) {
    const a = Math.max(0, Number(altM) || 0);
    if (a === 0) return 0;
    return Math.max(50, a * 0.12);
}

// ── Color helper ─────────────────────────────────────────────────────────────
function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

// ── sizeScale: match 2D icon size (aeris formula) ────────────────────────────
// BASE_3D_MODEL_SIZE=18, zoom compensation = 2^(REF_ZOOM - zoom) when zoom < REF_ZOOM
const BASE_SIZE = 18;
const REF_ZOOM  = 7.5;
function sizeScaleForZoom(zoom) {
    const compensation = zoom < REF_ZOOM ? Math.pow(2, REF_ZOOM - zoom) : 1;
    return Math.max(10, Math.round(BASE_SIZE * compensation));
}

// ── MapView3D ─────────────────────────────────────────────────────────────────
export default function MapView3D({
    planesDict = {},
    selectedIcao24,
    onSelectPlane,
    trackPoints = [],
    colorScheme = 'altitude',
    syncViewport,
    initialLng,
    initialLat,
    initialZoom,
    mapLayer = 'dark',
}) {
    const mapContainerRef = useRef(null);
    const mapRef          = useRef(null);
    const overlayRef      = useRef(null);
    const syncTimerRef    = useRef(null);

    // Live refs for buildLayers (avoids stale closure in RAF loop)
    const planesDictRef = useRef(planesDict);
    const selectedRef   = useRef(selectedIcao24);
    const trackRef      = useRef(trackPoints);
    const colorRef      = useRef(colorScheme);
    const syncVpRef     = useRef(syncViewport);
    const onSelectRef   = useRef(onSelectPlane);

    planesDictRef.current = planesDict;
    selectedRef.current   = selectedIcao24;
    trackRef.current      = trackPoints;
    colorRef.current      = colorScheme;
    syncVpRef.current     = syncViewport;
    onSelectRef.current   = onSelectPlane;

    // ── Build deck.gl layers ────────────────────────────────────────────────
    const buildLayers = useCallback(() => {
        const planes   = Object.values(planesDictRef.current);
        const selected = selectedRef.current;
        const scheme   = colorRef.current;
        const rawTrack = trackRef.current;
        const zoom     = mapRef.current?.getZoom() ?? 7;
        const sizeScale = sizeScaleForZoom(zoom);
        const layers   = [];

        // ── 3D trail with real altitude ─────────────────────────────────
        if (rawTrack && rawTrack.length >= 2) {
            const processed = processTrailPath(rawTrack);
            if (processed && processed.length >= 2) {
                const segments = [];
                let seg = [[normalizeLongitude(processed[0][2]), processed[0][1], altToElev(processed[0][3])]];
                for (let i = 1; i < processed.length; i++) {
                    const prev = processed[i - 1];
                    const cur  = processed[i];
                    if ((cur[0] - prev[0]) > 1800) {
                        if (seg.length >= 2) segments.push(seg);
                        seg = [];
                    }
                    seg.push([normalizeLongitude(cur[2]), cur[1], altToElev(cur[3])]);
                }
                if (seg.length >= 2) segments.push(seg);

                if (segments.length > 0) {
                    // Elevated 3D trail
                    layers.push(new PathLayer({
                        id: 'trail-3d',
                        data: segments,
                        getPath: d => d,
                        getColor: [255, 220, 100, 220],
                        getWidth: 3,
                        widthUnits: 'pixels',
                        widthMinPixels: 2,
                        capRounded: true,
                        jointRounded: true,
                        pickable: false,
                    }));
                    // Ground shadow
                    layers.push(new PathLayer({
                        id: 'trail-shadow',
                        data: segments.map(s => s.map(([lng, lat]) => [lng, lat, 0])),
                        getPath: d => d,
                        getColor: [255, 220, 100, 60],
                        getWidth: 1,
                        widthUnits: 'pixels',
                        pickable: false,
                    }));
                }
            }
        }

        // ── Aircraft (ScenegraphLayer, per model type) ───────────────────
        const groups = {};
        for (const p of planes) {
            if (!p.lat || !p.lng) continue;
            const mk = resolveModel(p._activeTypecode || p.typecode, p.category);
            if (!groups[mk]) groups[mk] = [];
            groups[mk].push(p);
        }

        for (const [mk, group] of Object.entries(groups)) {
            const yawOffset = MODEL_YAW_OFFSET[mk] ?? 90;
            layers.push(new ScenegraphLayer({
                id: `planes-3d-${mk}`,
                data: group,
                scenegraph: MODEL_URLS[mk],
                getPosition: p => [
                    normalizeLongitude(p.renderLng ?? p.lng),
                    p.renderLat ?? p.lat,
                    altToElev(p.altitude),
                ],
                // aeris formula: [pitch, yawOffset - trueTrack, baseRoll=90]
                getOrientation: p => {
                    const hdg   = p.heading  ?? 0;
                    const vRate = p.vRate    ?? 0;
                    const vel   = Math.max(1, p.velocity ?? 1);
                    const pitch = (-Math.atan2(vRate, vel) * 180) / Math.PI;
                    const yaw   = yawOffset - hdg;
                    return [pitch, yaw, 90];
                },
                sizeScale,
                getColor: p => {
                    if (p.icao24 === selected) return [0, 220, 255, 255];
                    if (p.isEmergency) return [255, 80, 80, 255];
                    if (p.onGround)    return [150, 150, 150, 200];
                    const hex = getAltitudeColor(p.altitude, p.onGround, p.isEmergency, scheme);
                    return [...hexToRgb(hex), 240];
                },
                _lighting: 'flat',
                pickable: true,
                autoHighlight: true,
                highlightColor: [0, 220, 255, 80],
                updateTriggers: {
                    getPosition: [planes],
                    getOrientation: [planes],
                    getColor: [selected, scheme],
                    sizeScale: [sizeScale],
                },
            }));
        }

        // ── Selected plane ring ──────────────────────────────────────────
        if (selected && planesDictRef.current[selected]) {
            const sp = planesDictRef.current[selected];
            layers.push(new ScatterplotLayer({
                id: 'selected-ring',
                data: [sp],
                getPosition: p => [
                    normalizeLongitude(p.renderLng ?? p.lng),
                    p.renderLat ?? p.lat,
                    altToElev(p.altitude),
                ],
                getRadius: 6000,
                radiusUnits: 'meters',
                getColor: [0, 220, 255, 50],
                stroked: true,
                getLineColor: [0, 220, 255, 200],
                getLineWidth: 150,
                lineWidthUnits: 'meters',
                pickable: false,
            }));
        }

        return layers;
    }, []);

    // ── Initialize MapLibre + MapboxOverlay ───────────────────────────────
    useEffect(() => {
        if (!mapContainerRef.current) return;

        const startLng  = initialLng  ?? 121.5;
        const startLat  = initialLat  ?? 25.0;
        const startZoom = initialZoom ?? 6;

        const map = new maplibregl.Map({
            container: mapContainerRef.current,
            style: getMapStyle(mapLayer),
            center: [startLng, startLat],
            zoom:   startZoom,
            pitch:  0,
            bearing: 0,
            antialias: true,
        });
        mapRef.current = map;

        // MapboxOverlay: shares WebGL context with MapLibre
        const overlay = new MapboxOverlay({
            interleaved: false,
            views: new MapView({ id: 'mapbox' }),
            pickingRadius: 14,
            useDevicePixels: 1,
            layers: [],
        });
        overlayRef.current = overlay;
        map.addControl(overlay);

        map.on('load', () => {
            // Initial layer render
            overlay.setProps({ layers: buildLayers() });
            // Smooth tilt: flat → 3D
            map.easeTo({ pitch: 55, bearing: 0, duration: 1000,
                easing: t => t < 0.5 ? 2*t*t : -1+(4-2*t)*t });
        });

        // Click → pick aircraft via overlay
        map.on('click', e => {
            const picked = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 14 });
            if (picked?.object) {
                onSelectRef.current?.(picked.object.icao24);
            } else {
                onSelectRef.current?.(null);
            }
        });

        // Cursor on hover
        map.on('mousemove', e => {
            const hit = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 8 });
            map.getCanvas().style.cursor = hit?.object ? 'pointer' : '';
        });

        // Sync viewport to backend (debounced)
        map.on('moveend', () => {
            const sv = syncVpRef.current;
            if (!sv) return;
            clearTimeout(syncTimerRef.current);
            syncTimerRef.current = setTimeout(() => {
                const b = map.getBounds();
                sv({ lamin: b.getSouth(), lamax: b.getNorth(), lomin: b.getWest(), lomax: b.getEast() });
            }, 800);
        });

        return () => {
            clearTimeout(syncTimerRef.current);
            map.remove();
            mapRef.current    = null;
            overlayRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Update layers when data changes ──────────────────────────────────
    useEffect(() => {
        if (overlayRef.current) {
            overlayRef.current.setProps({ layers: buildLayers() });
        }
    }, [planesDict, selectedIcao24, trackPoints, colorScheme, buildLayers]);

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
            <div ref={mapContainerRef} style={{ position: 'absolute', inset: 0 }} />
            <div style={{
                position: 'absolute', bottom: 28, right: 16,
                background: 'rgba(15,17,26,0.75)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8, padding: '6px 12px',
                fontSize: 11, color: 'rgba(255,255,255,0.5)',
                pointerEvents: 'none', backdropFilter: 'blur(4px)',
            }}>
                右鍵拖曳旋轉 · 滾輪縮放
            </div>
        </div>
    );
}
