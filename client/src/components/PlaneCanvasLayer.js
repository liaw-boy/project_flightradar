import L from 'leaflet';

/**
 * Custom Leaflet Canvas Layer for high-performance plane rendering.
 * Attaches a raw <canvas> to the overlay pane and stays in sync with
 * map pan/zoom via Leaflet's animation hooks.
 */
const PlaneCanvasLayer = L.Layer.extend({
    onAdd: function (map) {
        this._map = map;
        this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated');
        this._canvas.style.pointerEvents = 'none';
        this._canvas.style.zIndex = 10;
        this.ctx = this._canvas.getContext('2d', { alpha: true });

        map.getPanes().overlayPane.appendChild(this._canvas);
        // 'move' fires on every pointermove during a drag — tens of times per
        // gesture. It only needs to reposition the canvas element; it must
        // NOT touch canvas.width/height, since assigning either (even to the
        // same value) forces the browser to discard and reallocate the whole
        // GPU backing store. That reallocation, stacked on top of the 60fps
        // draw loop in MapView's animate(), was the main cause of pan/drag
        // jank with thousands of aircraft on screen.
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
    },
    // Reallocates the backing store — only ever needed when the viewport's
    // pixel dimensions actually change (window resize, or the initial mount).
    _resize: function () {
        const size = this._map.getSize();
        const dpr = window.devicePixelRatio || 1;
        this._canvas.width = size.x * dpr;
        this._canvas.height = size.y * dpr;
        this._canvas.style.width = size.x + 'px';
        this._canvas.style.height = size.y + 'px';
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._reposition();
    },
    // Cheap: just moves the existing canvas element to track the map's pan
    // offset. animate()'s own per-frame clearRect (MapView.jsx) already
    // handles clearing, so this doesn't need to touch pixel content at all.
    _reposition: function () {
        const topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, topLeft);
    },
    _animateZoom: function (e) {
        const scale = this._map.getZoomScale(e.zoom);
        const offset = this._map._latLngBoundsToNewLayerBounds(this._map.getBounds(), e.zoom, e.center).min;
        L.DomUtil.setTransform(this._canvas, offset, scale);
    },
    getCanvas: function () { return this._canvas; }
});

export default PlaneCanvasLayer;
