import L from 'leaflet';
import { vectorPathsMap } from './mapViewUtils';

// ── [Task B — experimental] GPU-batched plane layer ─────────────────────
// Default-off, opt-in (?renderer=webgl) alternative render path inspired by
// airplanes.live's use of OpenLayers' WebGLPoints for batch-rendering
// thousands of points on the GPU. Leaflet has no built-in equivalent, so
// this hand-rolls a minimal WebGL2 instanced-quad renderer: one shared
// sprite atlas (built once, reused for the component's lifetime) + two
// `drawArraysInstanced` calls per frame (a drop-shadow pass then the icon
// pass, fr24-style — see the shadow uniforms below), instead of one
// `drawImage` per plane. This is INDEPENDENT of PlaneCanvasLayer.js / MapView.jsx's
// existing Canvas 2D tiered icon rendering — that remains the untouched
// production path. This layer is purely additive and experimental: not
// perf-validated against thousands of live aircraft, no text labels, no
// hit-testing. Treat it as a technology proof-of-concept for a future
// GPU-batched renderer, not a drop-in replacement.
//
// [Sprite atlas] The atlas is no longer two hand-drawn placeholder
// silhouettes — it is baked once, at layer init, from the SAME
// `vectorPathsMap` (typecode -> {path: Path2D, vb: ink bbox}) that
// MapView.jsx's Canvas2D Tier-3 path already uses (built in
// mapViewUtils.js from `AIRCRAFT_CATALOG`, the real 182-type open-source
// silhouette catalog — github.com/RexKramer1/AircraftShapesSVG.git).
// Importing that module-level singleton here (rather than re-measuring
// SVG bboxes ourselves) guarantees this layer renders the exact same
// shapes, at the exact same relative scale, as the production Canvas2D
// path — including its category-fallback behavior (resolveTypecodeKey),
// with zero duplicated fallback logic.

const ATLAS_CELL_PX = 64;
// Fraction of a cell's edge the tallest/widest dimension of a shape is
// scaled to fill. The remaining margin is fully transparent and doubles
// as inter-cell padding, so gl.LINEAR sampling near a cell edge blends
// against transparent alpha rather than bleeding into the neighboring
// sprite (cheap alternative to a real padded-atlas packer).
const ATLAS_CELL_FILL = 0.82;

const FLOATS_PER_INSTANCE = 9; // x, y, rotation, scale, r, g, b, a, spriteIndex

// [Shadow pass] Fixed screen-space offset (css px, both axes) for the
// drop-shadow draw call in render() — matches fr24's small "floating"
// offset. Not exposed as a tunable; there's no existing per-layer config
// pattern in this file to hang it off of, and a fixed value is enough to
// read as a shadow.
const SHADOW_OFFSET_PX = 2.5;

const VERTEX_SRC = `#version 300 es
precision highp float;

// Per-vertex (shared unit quad, -0.5..0.5)
in vec2 a_quadPos;
in vec2 a_quadUv;

// Per-instance
in vec2 a_instPos;      // container-pixel position
in float a_instRotation; // radians
in float a_instScale;    // sprite draw size in px
in vec4 a_instColor;
in float a_instSprite;   // sprite column index (0 or 1)

uniform vec2 u_canvasSize; // css px
uniform float u_atlasCols;
uniform float u_atlasRows;
// [Shadow pass — fr24-inspired] When nonzero, this draw call is the
// drop-shadow pass: same instance data (position/rotation/scale/sprite) as
// the main pass, just nudged a couple css-px in screen space so it reads as
// a soft shadow "under" the icon drawn afterward. Toggled per draw call via
// this uniform (not per-instance) since the shadow pass renders every
// instance identically — no per-plane variation needed.
uniform float u_shadowMode;
uniform vec2 u_shadowOffsetPx;

out vec2 v_uv;
out vec4 v_color;

void main() {
    float c = cos(a_instRotation);
    float s = sin(a_instRotation);
    vec2 rotated = vec2(
        a_quadPos.x * c - a_quadPos.y * s,
        a_quadPos.x * s + a_quadPos.y * c
    );
    vec2 pixelPos = a_instPos + rotated * a_instScale;
    pixelPos += u_shadowOffsetPx * u_shadowMode;

    // pixel space -> clip space, y-flip (canvas origin is top-left)
    vec2 clip = (pixelPos / u_canvasSize) * 2.0 - 1.0;
    clip.y = -clip.y;

    gl_Position = vec4(clip, 0.0, 1.0);

    // Grid atlas: a_instSprite is a linear cell index (row-major); split it
    // back into column/row so a large multi-row atlas (182 typecodes) can
    // be addressed the same way the old single-row 2-cell atlas was.
    float col = mod(a_instSprite, u_atlasCols);
    float row = floor(a_instSprite / u_atlasCols);
    vec2 uv = a_quadUv;
    uv.x = (uv.x + col) / u_atlasCols;
    uv.y = (uv.y + row) / u_atlasRows;
    v_uv = uv;
    v_color = a_instColor;
}
`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec4 v_color;
uniform sampler2D u_atlas;
uniform float u_shadowMode;
out vec4 outColor;

// [Shadow pass] fr24's public build renders its "aircraft-shadows" layer by
// reusing the same sprite atlas + instance data as the main icon layer, but
// masking the texture to solid black at a fixed low alpha instead of the
// instance's real color — same mix()-based mask/tint switch this shader
// already uses per-pass (see u_shadowMode below), just driven by a per-draw
// uniform here rather than a per-instance attribute, since every shadow
// instance is tinted identically.
const vec3 SHADOW_COLOR = vec3(0.0, 0.0, 0.0);
const float SHADOW_ALPHA = 0.25;

void main() {
    float mask = texture(u_atlas, v_uv).a;
    if (mask < 0.02) discard;
    vec3 color = mix(v_color.rgb, SHADOW_COLOR, u_shadowMode);
    float alpha = mix(v_color.a, SHADOW_ALPHA, u_shadowMode) * mask;
    outColor = vec4(color, alpha);
}
`;

function compileShader(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error('PlaneWebGLLayer shader compile failed: ' + info);
    }
    return shader;
}

function linkProgram(gl, vsSrc, fsSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error('PlaneWebGLLayer program link failed: ' + info);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
}

// Bakes every typecode silhouette in `vectorPathsMap` (real AIRCRAFT_CATALOG
// Path2D shapes, ink-bbox measured — same data the Canvas2D Tier-3 path
// uses) into one offscreen 2D canvas, once, at layer init. Shapes are
// filled solid white — only the alpha channel is sampled by the fragment
// shader (as a mask), so per-plane tinting happens entirely via the
// instance color attribute rather than needing one atlas cell per color.
//
// 182 catalog entries at a 64px cell is a ~14x13 grid (~900x850px canvas)
// and a one-time cost of a couple hundred Path2D fills — negligible next to
// building `vectorPathsMap` itself (which MapView.jsx's Canvas2D path
// already pays on every load) and nowhere near WebGL's ~8K/side texture
// ceiling, so there was no need for a "common types only" tiered fallback:
// every typecode gets its own atlas cell.
//
// Returns { canvas, cols, rows, spriteIndexByKey }.
function buildAtlasFromCatalog() {
    const keys = Array.from(vectorPathsMap.keys());
    const cols = Math.max(1, Math.ceil(Math.sqrt(keys.length)));
    const rows = Math.max(1, Math.ceil(keys.length / cols));

    const canvas = document.createElement('canvas');
    canvas.width = cols * ATLAS_CELL_PX;
    canvas.height = rows * ATLAS_CELL_PX;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';

    const spriteIndexByKey = new Map();
    const fillPx = ATLAS_CELL_PX * ATLAS_CELL_FILL;

    keys.forEach((key, i) => {
        const entry = vectorPathsMap.get(key);
        spriteIndexByKey.set(key, i);
        if (!entry || !entry.path) return; // leave cell blank (fully transparent)

        const col = i % cols;
        const row = Math.floor(i / cols);
        const vb = entry.vb || [0, 0, ATLAS_CELL_PX, ATLAS_CELL_PX];
        const maxDim = Math.max(vb[2], vb[3]) || 1;
        const scale = fillPx / maxDim;

        ctx.save();
        ctx.translate(col * ATLAS_CELL_PX + ATLAS_CELL_PX / 2, row * ATLAS_CELL_PX + ATLAS_CELL_PX / 2);
        ctx.scale(scale, scale);
        ctx.translate(-(vb[0] + vb[2] / 2), -(vb[1] + vb[3] / 2));
        ctx.fill(entry.path);
        ctx.restore();
    });

    return { canvas, cols, rows, spriteIndexByKey };
}

const PlaneWebGLLayer = L.Layer.extend({
    onAdd: function (map) {
        this._map = map;
        this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated');
        this._canvas.style.pointerEvents = 'none';
        this._canvas.style.zIndex = 11; // above the Canvas2D layer (10)
        map.getPanes().overlayPane.appendChild(this._canvas);

        const gl = this._canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: false });
        if (!gl) {
            // eslint-disable-next-line no-console
            console.error('[PlaneWebGLLayer] WebGL2 unavailable — layer will render nothing.');
            this.gl = null;
        } else {
            this.gl = gl;
            this._initGl();
        }

        map.on('move', this._reposition, this);
        map.on('resize', this._resize, this);
        if (map.options.zoomAnimation && L.Browser.any3d) {
            map.on('zoomanim', this._animateZoom, this);
        }
        this._resize();
    },

    onRemove: function (map) {
        map.getPanes().overlayPane.removeChild(this._canvas);
        map.off('move', this._reposition, this);
        map.off('resize', this._resize, this);
        if (map.options.zoomAnimation) {
            map.off('zoomanim', this._animateZoom, this);
        }
        const gl = this.gl;
        if (gl) {
            gl.deleteBuffer(this._quadBuf);
            gl.deleteBuffer(this._uvBuf);
            gl.deleteBuffer(this._instBuf);
            gl.deleteTexture(this._atlasTex);
            gl.deleteProgram(this._program);
        }
    },

    _initGl: function () {
        const gl = this.gl;
        this._program = linkProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
        gl.useProgram(this._program);

        this._locs = {
            quadPos: gl.getAttribLocation(this._program, 'a_quadPos'),
            quadUv: gl.getAttribLocation(this._program, 'a_quadUv'),
            instPos: gl.getAttribLocation(this._program, 'a_instPos'),
            instRotation: gl.getAttribLocation(this._program, 'a_instRotation'),
            instScale: gl.getAttribLocation(this._program, 'a_instScale'),
            instColor: gl.getAttribLocation(this._program, 'a_instColor'),
            instSprite: gl.getAttribLocation(this._program, 'a_instSprite'),
            canvasSize: gl.getUniformLocation(this._program, 'u_canvasSize'),
            atlasCols: gl.getUniformLocation(this._program, 'u_atlasCols'),
            atlasRows: gl.getUniformLocation(this._program, 'u_atlasRows'),
            atlas: gl.getUniformLocation(this._program, 'u_atlas'),
            shadowMode: gl.getUniformLocation(this._program, 'u_shadowMode'),
            shadowOffsetPx: gl.getUniformLocation(this._program, 'u_shadowOffsetPx'),
        };

        this._vao = gl.createVertexArray();
        gl.bindVertexArray(this._vao);

        // Shared unit quad (two triangles), local coords -0.5..0.5, plus UVs.
        const quad = new Float32Array([
            -0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
            -0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
        ]);
        // [2026-09-01 fix] uv.y was paired with the wrong quadPos.y — the
        // vertex with more-negative pixel-Y (visually "up" on screen, since
        // this is Y-down pixel space) was sampling uv.y=1 (the atlas's tail
        // row), while the nose lives at uv.y=0. Every icon rendered
        // upside-down regardless of heading — reported as "all planes look
        // like they're flying backward". Flipping v here (not touching the
        // rotation trig, not touching Canvas2D) fixes the pairing.
        const uv = new Float32Array([
            0, 0, 1, 0, 0, 1,
            0, 1, 1, 0, 1, 1,
        ]);

        this._quadBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this._locs.quadPos);
        gl.vertexAttribPointer(this._locs.quadPos, 2, gl.FLOAT, false, 0, 0);

        this._uvBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._uvBuf);
        gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this._locs.quadUv);
        gl.vertexAttribPointer(this._locs.quadUv, 2, gl.FLOAT, false, 0, 0);

        // Instance buffer — reallocated lazily in render() as capacity grows.
        this._instCapacity = 4096;
        this._instBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._instBuf);
        gl.bufferData(gl.ARRAY_BUFFER, this._instCapacity * FLOATS_PER_INSTANCE * 4, gl.DYNAMIC_DRAW);
        this._setupInstanceAttribs();

        gl.bindVertexArray(null);

        // Sprite atlas texture — built once, kept for the layer's lifetime.
        const { canvas: atlasCanvas, cols: atlasCols, rows: atlasRows, spriteIndexByKey } = buildAtlasFromCatalog();
        this._atlasCols = atlasCols;
        this._atlasRows = atlasRows;
        this._spriteIndexByKey = spriteIndexByKey;
        this._atlasTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._atlasTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    },

    _setupInstanceAttribs: function () {
        const gl = this.gl;
        const stride = FLOATS_PER_INSTANCE * 4;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._instBuf);

        gl.enableVertexAttribArray(this._locs.instPos);
        gl.vertexAttribPointer(this._locs.instPos, 2, gl.FLOAT, false, stride, 0);
        gl.vertexAttribDivisor(this._locs.instPos, 1);

        gl.enableVertexAttribArray(this._locs.instRotation);
        gl.vertexAttribPointer(this._locs.instRotation, 1, gl.FLOAT, false, stride, 8);
        gl.vertexAttribDivisor(this._locs.instRotation, 1);

        gl.enableVertexAttribArray(this._locs.instScale);
        gl.vertexAttribPointer(this._locs.instScale, 1, gl.FLOAT, false, stride, 12);
        gl.vertexAttribDivisor(this._locs.instScale, 1);

        gl.enableVertexAttribArray(this._locs.instColor);
        gl.vertexAttribPointer(this._locs.instColor, 4, gl.FLOAT, false, stride, 16);
        gl.vertexAttribDivisor(this._locs.instColor, 1);

        gl.enableVertexAttribArray(this._locs.instSprite);
        gl.vertexAttribPointer(this._locs.instSprite, 1, gl.FLOAT, false, stride, 32);
        gl.vertexAttribDivisor(this._locs.instSprite, 1);
    },

    _resize: function () {
        const size = this._map.getSize();
        const dpr = window.devicePixelRatio || 1;
        this._canvas.width = size.x * dpr;
        this._canvas.height = size.y * dpr;
        this._canvas.style.width = size.x + 'px';
        this._canvas.style.height = size.y + 'px';
        this._cssSize = { x: size.x, y: size.y };
        if (this.gl) this.gl.viewport(0, 0, this._canvas.width, this._canvas.height);
        this._reposition();
    },

    _reposition: function () {
        const topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, topLeft);
    },

    _animateZoom: function (e) {
        const scale = this._map.getZoomScale(e.zoom);
        const offset = this._map._latLngBoundsToNewLayerBounds(this._map.getBounds(), e.zoom, e.center).min;
        L.DomUtil.setTransform(this._canvas, offset, scale);
    },

    getCanvas: function () { return this._canvas; },

    // Resolves a vectorPathsMap/AIRCRAFT_CATALOG key (e.g. from
    // getAircraftVectorKey(plane) — same fallback chain MapView.jsx's
    // Canvas2D Tier-3 path uses) to this atlas's linear sprite index.
    // Falls back to cell 0 for a key that somehow isn't in the atlas
    // (shouldn't happen: resolveTypecodeKey() guarantees a catalog key).
    getSpriteIndex: function (vectorKey) {
        if (!this._spriteIndexByKey) return 0;
        const idx = this._spriteIndexByKey.get(vectorKey);
        return idx === undefined ? 0 : idx;
    },

    // instances: Float32Array laid out per-plane as
    //   [x, y, rotationRad, scalePx, r, g, b, a, spriteIndex]
    // count: number of instances actually populated (buffer may be larger).
    render: function (instances, count) {
        const gl = this.gl;
        if (!gl) return;

        const dpr = window.devicePixelRatio || 1;
        gl.viewport(0, 0, this._canvas.width, this._canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (!count) return;

        gl.useProgram(this._program);
        gl.bindVertexArray(this._vao);

        if (count > this._instCapacity) {
            this._instCapacity = Math.ceil(count * 1.5);
            gl.bindBuffer(gl.ARRAY_BUFFER, this._instBuf);
            gl.bufferData(gl.ARRAY_BUFFER, this._instCapacity * FLOATS_PER_INSTANCE * 4, gl.DYNAMIC_DRAW);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this._instBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * FLOATS_PER_INSTANCE);

        gl.uniform2f(this._locs.canvasSize, this._cssSize ? this._cssSize.x : this._canvas.width / dpr, this._cssSize ? this._cssSize.y : this._canvas.height / dpr);
        gl.uniform1f(this._locs.atlasCols, this._atlasCols || 1);
        gl.uniform1f(this._locs.atlasRows, this._atlasRows || 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._atlasTex);
        gl.uniform1i(this._locs.atlas, 0);

        // [Shadow pass — fr24-inspired] Draw the exact same instance buffer
        // once more first, in shadow mode (uniform-toggled black/translucent
        // mask + small screen-space offset — see fragment/vertex shaders
        // above), so it lands underneath the real icon pass drawn right
        // after it. Same VAO, same buffer, same program: just two draw
        // calls instead of one, bracketed by the uniform flip.
        gl.uniform2f(this._locs.shadowOffsetPx, SHADOW_OFFSET_PX, SHADOW_OFFSET_PX);
        gl.uniform1f(this._locs.shadowMode, 1.0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);

        gl.uniform1f(this._locs.shadowMode, 0.0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);

        gl.bindVertexArray(null);
    },
});

export default PlaneWebGLLayer;
export { FLOATS_PER_INSTANCE };
