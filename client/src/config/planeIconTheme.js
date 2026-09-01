// ─────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for aircraft-icon appearance on the canvas map.
//
// Every color, size curve, and threshold that controls how a plane icon
// looks (MapView.jsx's render loop) or how the altitude legend looks
// (AltitudeLegend.jsx) should live here, not as an inline literal in a
// render function. To change the look of plane icons, edit this file —
// MapView.jsx's animate() loop should never need to change for a pure
// style tweak.
// ─────────────────────────────────────────────────────────────────────────

// ── Altitude color ramp (HSL, altitude in METRES) ──────────────────────────
// Matches tar1090's actual shipped default (html/config.js ColorByAlt.air) —
// verified against tar1090's own source, not an approximation: 3 hue anchors
// linearly interpolated, constant saturation/lightness. Altitudes below the
// first anchor use its hue; above the last, its hue (see getAltitudeColor).
// Both the on-map icons (via getAltitudeColor in flightUtils.js) and the
// bottom altitude legend (AltitudeLegend.jsx) derive their colors from this
// single ramp.
export const ALT_STOPS = [
    { alt:   610, h:  20, s: 88, l: 44 }, // orange        — 2,000ft
    { alt:  3048, h: 140, s: 88, l: 44 }, // light green   — 10,000ft
    { alt: 12192, h: 300, s: 88, l: 44 }, // magenta       — 40,000ft (jet cruise)
];

// tar1090's ground/unknown-altitude colors are deliberately NEUTRAL (no hue)
// rather than reusing a ramp color — a taxiing aircraft's grey is visually
// distinct from "this is the lowest point on the altitude gradient".
export const GROUND_COLOR = { h: 0, s: 0, l: 45 };
export const UNKNOWN_ALT_COLOR = { h: 0, s: 0, l: 75 };

// ── Icon size: zoom → base pixel size curve ────────────────────────────────
// adsb.fi/FR24-style. See aircraftIcons.js's getDrawSize() history comment
// for why this curve is shaped the way it is.
export const ZOOM_SIZE_TABLE = [
    { maxZoom: 4,  px: 15 }, // floor — always a recognizable shape, never a dot
    { maxZoom: 5,  px: 18 },
    { maxZoom: 6,  px: 20 },
    { maxZoom: 7,  px: 24 },
    { maxZoom: 8,  px: 28 },
    { maxZoom: 9,  px: 31 },
    { maxZoom: 10, px: 34 },
    { maxZoom: 11, px: 37 },
    { maxZoom: 12, px: 40 },
    { maxZoom: 13, px: 43 },
    { maxZoom: 14, px: 46 },
    { maxZoom: 15, px: 49 },
];
// Beyond the table's last tier (zoom > 15): base = min(CEILING_PX, CEILING_BASE_PX + (zoom-15)*CEILING_STEP_PX)
export const ZOOM_SIZE_CEILING_BASE_PX = 49;
export const ZOOM_SIZE_CEILING_STEP_PX = 2;
export const ZOOM_SIZE_CEILING_PX = 53;

// Per-typecode size differentiation (AIRCRAFT_CATALOG[...].scale, 1.00-2.58)
// normalized against the narrow-body baseline and clamped so size varies by
// type but stays subtle, not jarring.
export const TYPE_SCALE_REF = 1.45;   // B738 / A320 catalog scale = 1.0×
export const TYPE_SCALE_MIN = 0.85;
export const TYPE_SCALE_MAX = 1.4;

// Bump when ALT_STOPS/ZOOM_SIZE_*/TYPE_SCALE_* change — busts MapView's
// per-(typecode,zoom) drawSize cache (scaleCacheRef).
export const ICON_SCALE_VERSION = 5;

// ── 3-tier render pipeline thresholds ───────────────────────────────────────
export const TIER1_MAX_DRAW_SIZE = 3; // drawSize <= this → tactical dot, not a shape
export const TIER4_FALLBACK_RADIUS = 5; // px, safety-net dot when no Path2D resolves

// ── Focus-mode dimming (another plane selected) ─────────────────────────────
export const FOCUS_DIM_OPACITY = 0.3;

// ── Selected-aircraft pulsing glow ring ─────────────────────────────────────
export const SELECTION_GLOW = {
    color: '#22d3ee',
    outer: { baseRadius: 14, pulseRadiusRange: 22, pulsePeriodMs: 2000, lineWidth: 1.5, alphaMax: 0.55 },
    inner: { radius: 10, lineWidth: 3, alpha: 0.25 },
};

// ── Icon outline/stroke colors ──────────────────────────────────────────────
// Dark-mode selected outline is a fixed gold; light-mode selected outline
// differs by tier (Tier 1 dot uses a fixed amber, Tier 3 vector uses the
// plane's own altitude color for contrast against the light basemap).
export const SELECTED_STROKE_DARK = '#FFD700';
export const TIER1_SELECTED_STROKE_LIGHT = '#b45309';

export const SHADOW_STROKE_LIGHT = 'rgba(255,255,255,0.9)'; // Tier 3 pass-1 outline, light basemap
export const SHADOW_STROKE_DARK = 'rgba(0,0,0,0.7)';        // Tier 3 pass-1 outline, dark basemap
export const NORMAL_STROKE_DARK = 'rgba(150,160,175,0.8)';  // Tier 3 pass-3 outline, dark + not selected

export const OUTLINE_LINE_WIDTH_PX = { shadow: 2.0, selected: 2.0, normal: 1.0 };
export const OUTLINE_LINE_WIDTH_MIN_PX = { shadow: 0.8, selected: 0.8, normal: 0.3 };

export const TIER1_DOT = {
    darkBorderColor: 'rgba(0,0,0,0.6)',
    darkBorderPad: 1.2,
    selectedOutlineWidth: 1.5,
};
