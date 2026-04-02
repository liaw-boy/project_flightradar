#!/usr/bin/env node
/**
 * Aircraft SVG Shape Preprocessor
 *
 * Parses all SVGs from AircraftShapesSVG repo, extracts path data,
 * and normalizes viewBoxes so aircraft render at physically proportional sizes.
 *
 * Output: client/src/data/aircraftShapesData.js
 */

const fs = require('fs');
const path = require('path');

const isDocker = fs.existsSync('/.dockerenv');
const SVG_DIR = isDocker
    ? path.join(__dirname, '..', 'assets', 'AircraftShapesSVG', 'Shapes SVG')
    : path.resolve(__dirname, '../assets/AircraftShapesSVG/Shapes SVG');
const OUTPUT = isDocker
    ? path.join(__dirname, '..', 'data', 'aircraftShapesData.js')
    : path.resolve(__dirname, '../client/src/data/aircraftShapesData.js');

// Ensure output directory exists
const outDir = path.dirname(OUTPUT);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// ── Reference wingspan data (meters) for proportional scaling ────────────────
// Used to normalize all aircraft so they render at correct relative sizes.
// Source: public aircraft specifications.
const WINGSPANS = {
    // Wide-body / Jumbo
    A388: 79.75, A380: 79.75, A225: 88.4, A124: 73.3,
    B744: 64.4, B748: 68.4, B742: 59.6, B74S: 59.6, BLCF: 64.4,
    B772: 60.9, B773: 64.8, B779: 71.8, B77L: 64.8, B77W: 64.8,
    B788: 60.1, B789: 60.1, B78X: 60.1,
    A332: 60.3, A333: 60.3, A337: 64.0, A338: 64.0, A339: 64.0,
    A342: 60.3, A343: 60.3, A345: 63.45, A346: 63.45,
    A359: 64.75, A35K: 64.75,
    A306: 44.84, A310: 43.9, A3ST: 44.84,
    MD11: 51.66, DC10: 50.39,
    IL76: 50.5, IL62: 43.2,
    C5M: 67.89, C17: 51.75, A400: 42.4,

    // Narrow-body
    A318: 34.1, A320: 35.8, A321: 35.8, A19N: 35.8, A20N: 35.8, A21N: 35.8,
    B737: 28.9, B738: 34.3, B739: 34.3, B733: 28.9, B734: 28.9, B735: 28.9,
    B38M: 35.9, B39M: 35.9,
    B703: 39.9, B712: 28.4, B722: 32.9,
    B752: 38.05, B753: 38.05,
    B762: 47.57, B763: 47.57, B764: 51.92,
    BCS1: 35.1, BCS3: 35.1,
    E170: 26.0, E195: 28.72,
    CRJ2: 21.21, CRJ7: 23.24, CRJ9: 24.85, CRJX: 26.18,
    E35L: 21.0, E390: 17.0,
    SU95: 27.8, T204: 42.0,
    RJ85: 26.34, F50: 29.0,

    // Turboprop / Regional
    AT45: 24.57, AT75: 27.05, ATP: 30.63,
    DH8C: 27.43, DH8D: 28.42,
    SF34: 21.44, D328: 20.98, D228: 16.97,
    J328: 20.98,
    C295: 25.81, CN35: 22.0, C130: 40.41, C160: 40.0,

    // Light / GA
    C172: 11.0, SR22: 11.68, PA46: 13.11, P28A: 10.67,
    DA42: 13.56, PC12: 16.28, PC6T: 15.87, P180: 14.41,
    C208: 15.87, B190: 16.56, BN2P: 14.94, SC7: 16.15,
    B350: 17.65, C25B: 14.3, C750: 19.35,
    FA7X: 26.21, GL5T: 28.4, GLF6: 28.5,
    LJ35: 12.04, F406: 15.66,
    DO27: 12.0, DO28: 15.55, SF25: 16.33,

    // Helicopter
    H60: 16.36, H47: 18.29, H64: 14.63,
    EC35: 10.69, EC45: 11.0, EC20: 7.9,
    AS32: 15.6, AS65: 13.68, R44: 10.06,
    S61: 18.9, UH1: 14.63, NH90: 16.3,
    GAZL: 10.5, LYNX: 12.8, MI24: 17.3, TIGR: 13.0,

    // Military
    F16: 9.96, F15: 13.05, F18H: 13.62, F18S: 13.62,
    F22: 13.56, F35: 10.67, VF35: 10.67, EUFI: 10.95,
    B52: 56.39, B1: 41.67, B29: 43.05,
    A10: 17.53, HAWK: 9.94, M326: 10.56,
    'TOR': 13.91, MIRA: 8.6, RFAL: 10.8, P3: 30.37, P8: 37.57,
    U2: 31.39, E3CF: 44.42, E3TF: 44.42, E737: 34.3, E8: 44.42,
    R135: 39.88, K35E: 39.88, KC2: 47.57, KC46: 47.57,
    C2: 44.4, F5: 8.13, L159: 9.54, T38: 7.7, SB39: 9.0,
    PC9: 10.12, ST75: 10.36,
    A4: 8.38, AJET: 9.39, P1: 35.4,
    HUNT: 10.26,

    // Special
    BALL: 5.0, GYRO: 8.0, V22: 25.5, CL2T: 28.6,
    SGUP: 44.84, AN12: 38.0, AN26: 29.2,
    DC87: 45.24, DC3: 28.96,
};

// Default wingspan by category
const DEFAULT_WINGSPANS = {
    JUMBO: 70, WIDE: 55, NARROW: 33, REGIONAL: 25, LIGHT: 12, HELI: 14, MILITARY: 12, UNKNOWN: 20,
};

// Category classification by type pattern
function classifyType(tc) {
    if (/^(A38|B74|A22|A12|BLCF|SGUP)/.test(tc)) return 'JUMBO';
    if (/^(A3[3-5]|B7[7-8]|MD1|DC1|IL7|C5M|C17|A40|B76)/.test(tc)) return 'WIDE';
    if (/^(A3[12]|A[12][0-9]N|B7[0-5]|B3[89]M|BCS|E1[79]|CRJ|RJ|SU9|T20|J32|F50)/.test(tc)) return 'NARROW';
    if (/^(AT[47]|ATP|DH8|SF3|D[23]2|C29|CN3|C13|C16|B19|AN)/.test(tc)) return 'REGIONAL';
    if (/^(H[46]|EC[234]|AS[36]|R44|S61|UH1|NH9|GAZ|LYN|MI2|TIG)/.test(tc)) return 'HELI';
    if (/^(F[12358]|B5[12]|B29|A10|A4|EUFI|HAWK|M32|TOR|MIR|RFA|SB3|PC9|ST7|L15|T38|U2|E[38]|R13|K[C3]|VF3|HUN|AJE|P[138])/.test(tc)) return 'MILITARY';
    if (/^(C17[2-9]|C1[0-4]\d|SR2|PA4|P28|DA4|PC[16]|C20[48]|C25|C75|BN2|SC7|B35|FA7|GL[5F]|LJ3|F40|DO2|SF2|P18)/.test(tc)) return 'LIGHT';
    return 'UNKNOWN';
}

// Reference wingspan: B738 = 34.3m → this will render at "1.0x" base size
const REFERENCE_WINGSPAN = 34.3;

function getWingspan(typecode) {
    // Direct match
    if (WINGSPANS[typecode]) return WINGSPANS[typecode];

    // Try without trailing variant letters (e.g., "B1 fast" → "B1")
    const base = typecode.replace(/[\s_](fast|slow)$/i, '');
    if (WINGSPANS[base]) return WINGSPANS[base];

    // Category default
    const cat = classifyType(typecode);
    return DEFAULT_WINGSPANS[cat];
}

// ── SVG Parsing ──────────────────────────────────────────────────────────────

function parseSVG(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Extract viewBox
    const vbMatch = content.match(/viewBox="([^"]+)"/);
    if (!vbMatch) return null;

    // Extract path data grouped by Inkscape layer
    // Strategy: find each <g> layer block, then extract <path d="..."> within it
    const paths = [];

    // Split by layer groups
    const layerBlocks = content.split(/inkscape:label="/);
    for (let i = 1; i < layerBlocks.length; i++) {
        const block = layerBlocks[i];
        const labelEnd = block.indexOf('"');
        const label = block.substring(0, labelEnd).trim();

        // Find all path d= attributes in this block (up to next layer or end)
        // Use a careful regex that matches d="..." attribute specifically
        const pathDRegex = /\sd="([^"]+)"/g;
        let pm;
        const blockPaths = [];
        while ((pm = pathDRegex.exec(block)) !== null) {
            const d = pm[1].trim();
            // Filter out non-path data (must start with m or M)
            if (/^[mM]/.test(d)) {
                blockPaths.push(d);
            }
        }

        if (label === 'Pfade' || label.startsWith('Pfade')) {
            // Outline paths go first
            for (const p of blockPaths) paths.unshift(p);
        } else if (label === 'Accent' || label.startsWith('Accent')) {
            // Accent detail paths go after
            for (const p of blockPaths) paths.push(p);
        }
    }

    // Fallback: direct extraction if no Inkscape layers found
    if (paths.length === 0) {
        const pathRegex = /\sd="(m[^"]+)"/gi;
        let pm;
        while ((pm = pathRegex.exec(content)) !== null) {
            paths.push(pm[1].trim());
        }
    }

    if (paths.length === 0) return null;

    return { viewBox: vbMatch[1], paths };
}

// ── Main Build ───────────────────────────────────────────────────────────────

function build() {
    const files = fs.readdirSync(SVG_DIR).filter(f => f.endsWith('.svg'));
    const shapes = {};
    let count = 0;

    for (const file of files) {
        const typecode = path.basename(file, '.svg');
        const normalizedKey = typecode.toUpperCase().replace(/\s+/g, '_');
        const filePath = path.join(SVG_DIR, file);

        const parsed = parseSVG(filePath);
        if (!parsed) {
            console.warn(`  SKIP: ${file} (no paths found)`);
            continue;
        }

        const wingspan = getWingspan(normalizedKey.replace(/_/g, ' '));
        const scaleFactor = wingspan / REFERENCE_WINGSPAN;
        const category = classifyType(normalizedKey);

        shapes[normalizedKey] = {
            viewBox: parsed.viewBox,
            paths: parsed.paths,
            scale: Math.round(scaleFactor * 1000) / 1000,
            category,
        };
        count++;
    }

    // Generate JS module
    const output = `// AUTO-GENERATED by scripts/build-aircraft-shapes.js — DO NOT EDIT
// Source: AircraftShapesSVG (GPLv3) by RexKramer1
// ${count} aircraft shapes, normalized with proportional wingspan scaling.

const AIRCRAFT_SHAPES = ${JSON.stringify(shapes, null, 0)};

export default AIRCRAFT_SHAPES;
`;

    // Ensure output directory exists
    const outDir = path.dirname(OUTPUT);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(OUTPUT, output, 'utf-8');
    console.log(`Built ${count} aircraft shapes → ${OUTPUT}`);

    // Print category summary
    const catCounts = {};
    for (const k in shapes) {
        const c = shapes[k].category;
        catCounts[c] = (catCounts[c] || 0) + 1;
    }
    console.log('Categories:', catCounts);
}

build();
