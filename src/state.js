/**
 * Minimal reactive state store. One `set` call, one round of listener fires,
 * no re-entrant updates from within subscribers.
 */

const listeners = new Set();

export const HARD_LIMIT_KM2 = 10000;

/** Search filters default to the last 30 days, computed fresh each call. */
export function defaultDateRange() {
  return {
    dateFrom: isoDate(new Date(Date.now() - 30 * 86400_000)),
    dateTo: isoDate(new Date()),
  };
}

// Static defaults for the fields url-state.js diffs against to decide what's
// worth putting in a shareable URL. dateFrom/dateTo aren't here since
// there's no fixed default to diff against — see defaultDateRange() above.
export const DEFAULT_STATE = {
  cloudCoverMax: 100,

  // Which map.js BASEMAPS entry is showing.
  basemap: 'map',

  // What the preview/export pipeline computes per pixel:
  //   'rgb'    — three bands composited straight into R/G/B
  //   'single' — one band, shown as grayscale (r = g = b = band value)
  //   'index'  — normalized difference of two bands: (a - b) / (a + b),
  //              shown as grayscale
  vizMode: 'rgb',
  // Which entry of the Bands panel's preset dropdown is active. 'custom'
  // once the user hand-edits a band picker away from a preset's mapping.
  preset: 'true-color',

  // Band → asset-key mapping for the RGB composite (Earth Search asset names)
  bands: { r: 'red', g: 'green', b: 'blue' },
  // Asset key used when vizMode === 'single'
  singleBand: 'nir',
  // Asset keys used when vizMode === 'index': index = (a - b) / (a + b)
  indexBands: { a: 'nir', b: 'red' },

  // Output pixel width — governed by the "Area" panel (never exceeds the
  // box's native pixel count for the collection). Height is derived from
  // the box aspect ratio at fetch time.
  targetWidth: 1000,

  // Visualisation (drives renderRGBA only, never re-fetches)
  viz: {
    vmin: 0,
    vmax: 3000,
    gamma: 1.0,
    format: 'png',
    // Colour ramp applied to 'single'/'index' vizMode (ignored for 'rgb').
    colormap: 'gray',
    // Flips which end of the stretch maps to which end of the ramp.
    colormapReversed: false,
  },
};

export const state = {
  ...defaultDateRange(),
  collection: 'sentinel-2-l2a',
  minSearchZoom: 4,
  nativeGSD: 10, // Sentinel-2 red/green/blue

  // STAC results
  items: [],
  itemsByDay: [],

  // User selection
  drawnBbox: null,
  drawnAreaKm2: 0,
  selectedDay: null,

  ...DEFAULT_STATE,
  bands: { ...DEFAULT_STATE.bands },
  indexBands: { ...DEFAULT_STATE.indexBands },
  viz: { ...DEFAULT_STATE.viz },

  // Live progress for the preview fetch
  loading: { active: false, done: 0, total: 0, message: '' },
};

export function set(patch) {
  Object.assign(state, patch);
  emit();
}

export function setViz(patch) {
  state.viz = { ...state.viz, ...patch };
  emit();
}

// Which asset key(s) the current vizMode reads — shared by main.js (the
// CPU export path) and live-preview.js (the GPU one), so the two can't
// drift apart on what "the active bands" means for a given mode.
export function activeBands() {
  if (state.vizMode === 'single') return { band: state.singleBand };
  if (state.vizMode === 'index') return state.indexBands;
  return state.bands;
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(state); }
    catch (err) { console.error('subscribe listener threw:', err); }
  }
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
