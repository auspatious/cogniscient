/**
 * Adds the STAC footprint layer + selection highlight to the given map.
 */

const EMPTY = { type: 'FeatureCollection', features: [] };

export const FOOTPRINT_LAYER_IDS = [
  'stac-items-fill', 'stac-items-outline',
  'stac-selected-fill', 'stac-selected-outline',
  'stac-hover-fill', 'stac-hover-outline',
];

export function addFootprintLayers(map) {
  map.addSource('stac-items', { type: 'geojson', data: EMPTY });
  map.addSource('stac-selected', { type: 'geojson', data: EMPTY });
  map.addSource('stac-hover', { type: 'geojson', data: EMPTY });

  map.addLayer({
    id: 'stac-items-fill',
    type: 'fill',
    source: 'stac-items',
    paint: {
      'fill-color': '#3474c7',
      'fill-opacity': 0.10,
    },
  });
  map.addLayer({
    id: 'stac-items-outline',
    type: 'line',
    source: 'stac-items',
    paint: {
      'line-color': '#3474c7',
      'line-width': 1,
      'line-opacity': 0.6,
    },
  });

  // Selected day: every scene found for that day is shown, not just ones
  // intersecting the drawn box — `_intersects` (set in main.js) picks
  // between a bold "used in the mosaic" gold and a plain "found nearby but
  // not used" blue, matching the ordinary all-items colour above.
  const intersectsColor = ['case', ['get', '_intersects'], '#fbc27b', '#3474c7'];
  map.addLayer({
    id: 'stac-selected-fill',
    type: 'fill',
    source: 'stac-selected',
    paint: {
      'fill-color': intersectsColor,
      'fill-opacity': 0.15,
    },
  });
  map.addLayer({
    id: 'stac-selected-outline',
    type: 'line',
    source: 'stac-selected',
    paint: {
      'line-color': intersectsColor,
      'line-width': ['case', ['get', '_intersects'], 3, 1],
    },
  });

  // Single-item highlight for hovering an item in the "Days" panel's item
  // list. Drawn on top of everything else.
  map.addLayer({
    id: 'stac-hover-fill',
    type: 'fill',
    source: 'stac-hover',
    paint: {
      'fill-color': '#ffffff',
      'fill-opacity': 0.2,
    },
  });
  map.addLayer({
    id: 'stac-hover-outline',
    type: 'line',
    source: 'stac-hover',
    paint: {
      'line-color': '#ffffff',
      'line-width': 2,
    },
  });
}

/**
 * Show all items' footprints. The selected-day layers draw on top.
 */
export function setFootprints(map, items) {
  map.getSource('stac-items')?.setData({ type: 'FeatureCollection', features: items ?? [] });
}

/**
 * Highlight the selected day's items on a dedicated (bolder, green) layer.
 */
export function setSelected(map, items) {
  map.getSource('stac-selected')?.setData({ type: 'FeatureCollection', features: items ?? [] });
}

/**
 * Highlight a single item (e.g. on hover in the item-list dropdown). Pass
 * `null` to clear.
 */
export function setHoverItem(map, item) {
  map.getSource('stac-hover')?.setData({ type: 'FeatureCollection', features: item ? [item] : [] });
}
