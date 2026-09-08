/**
 * Minimal click-drag rectangle drawer for MapLibre.
 * Emits an EPSG:4326 bbox [west, south, east, north] via onBbox callback.
 *
 * Usage:
 *   const draw = createRectangleDraw(map, ({ bbox }) => { ... });
 *   draw.start();  // enable drawing
 *   draw.clear();  // remove existing box
 */

const EMPTY = { type: 'FeatureCollection', features: [] };

// Whole-world ring (RFC 7946 exterior winding, counterclockwise) — paired
// with a clockwise hole for the drawn box, this fades out everything
// outside it. Not antimeridian-aware; fine for the box sizes this app
// actually supports.
const WORLD_RING = [[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]];

export function createRectangleDraw(map, onBbox) {
  const canvas = map.getCanvasContainer();
  let startLngLat = null;
  let active = false;

  function ensureSources() {
    if (map.getSource('draw-box')) return;
    map.addSource('draw-fade', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'draw-fade-fill',
      type: 'fill',
      source: 'draw-fade',
      paint: { 'fill-color': '#000000', 'fill-opacity': 0.45 },
    });
    map.addSource('draw-box', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'draw-box-fill',
      type: 'fill',
      source: 'draw-box',
      paint: { 'fill-color': '#f2f2f2', 'fill-opacity': 0.15 },
    });
    map.addLayer({
      id: 'draw-box-outline',
      type: 'line',
      source: 'draw-box',
      paint: {
        'line-color': '#f2f2f2',
        'line-width': 3,
        'line-dasharray': [2, 1],
      },
    });
  }

  function fadeMaskFor(west, south, east, north) {
    return {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          WORLD_RING,
          // Clockwise (opposite winding) — the hole revealing the box.
          [[west, south], [west, north], [east, north], [east, south], [west, south]],
        ],
      },
    };
  }

  function renderRectangle(a, b) {
    const west = Math.min(a.lng, b.lng);
    const east = Math.max(a.lng, b.lng);
    const south = Math.min(a.lat, b.lat);
    const north = Math.max(a.lat, b.lat);
    const poly = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ],
        ],
      },
    };
    ensureSources();
    map.getSource('draw-box').setData({ type: 'FeatureCollection', features: [poly] });
    map.getSource('draw-fade').setData(fadeMaskFor(west, south, east, north));
    return { west, south, east, north };
  }

  function onMouseDown(e) {
    if (!active) return;
    startLngLat = e.lngLat;
    // Draw a zero-size box immediately so the user sees a marker at the click.
    renderRectangle(e.lngLat, e.lngLat);
  }
  function onMouseMove(e) {
    if (!startLngLat || !active) return;
    renderRectangle(startLngLat, e.lngLat);
  }
  function onMouseUp(e) {
    if (!startLngLat || !active) return;
    const r = renderRectangle(startLngLat, e.lngLat);
    startLngLat = null;
    active = false;
    map.dragPan.enable();
    map.boxZoom.enable();
    canvas.style.cursor = '';
    // A stray click without a drag makes a zero-size box — treat as cancel.
    if (r.west === r.east || r.south === r.north) {
      map.getSource('draw-box').setData(EMPTY);
      map.getSource('draw-fade').setData(EMPTY);
      onBbox?.({ bbox: null });
      return;
    }
    onBbox?.({ bbox: [r.west, r.south, r.east, r.north] });
  }

  // Wire persistent handlers; they gate on `active` internally.
  map.on('mousedown', onMouseDown);
  map.on('mousemove', onMouseMove);
  map.on('mouseup', onMouseUp);

  return {
    start() {
      ensureSources();
      active = true;
      canvas.style.cursor = 'crosshair';
      // Disable panning and box-zoom BEFORE the user's mousedown, so they
      // don't compete with our drag.
      map.dragPan.disable();
      map.boxZoom.disable();
    },
    clear() {
      ensureSources();
      map.getSource('draw-box').setData(EMPTY);
      map.getSource('draw-fade').setData(EMPTY);
      onBbox?.({ bbox: null });
    },
    /** Draws a box from a [west, south, east, north] bbox (e.g. restored
     * from a shared URL) without going through a mouse drag. Doesn't fire
     * onBbox — the caller already knows the bbox and drives state itself. */
    setBbox(bbox) {
      const [west, south, east, north] = bbox;
      renderRectangle({ lng: west, lat: south }, { lng: east, lat: north });
    },
  };
}
