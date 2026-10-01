/**
 * Shareable app state lives in the URL's query string. The map's own
 * camera position already lives in the hash via MapLibre's `hash: true`,
 * so query params keep the two independent.
 *
 * Only fields that deviate from DEFAULT_STATE are written, and every value
 * uses characters (`-`, `.`, digits, letters) that application/x-www-form-
 * urlencoded never percent-encodes — so a shared URL stays plain text
 * instead of turning into %-escaped noise.
 *
 * Pure functions only — no `location`/`history` access here, so they're
 * plain to test. The caller (main.js) supplies the current search string
 * and applies the result / writes it back.
 */

import { DEFAULT_STATE } from './state.js';

/** Parses recognized params out of a query string (e.g. `location.search`). */
export function parseParams(search) {
  const params = new URLSearchParams(search);
  const out = {};

  const bbox = params.get('bbox');
  if (bbox) {
    const parts = bbox.split('_').map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) out.bbox = parts;
  }

  // `datetime` is a single day (the new format) unless it contains a `/`,
  // in which case it's a legacy date *range* — which can't express a
  // single selected day, so it doesn't set one here; a legacy
  // `selected_datetime` alongside it (below) is what old links relied on
  // for that instead.
  const datetime = params.get('datetime');
  if (datetime) {
    if (datetime.includes('/')) {
      const [from, to] = datetime.split('/');
      if (from) out.dateFrom = from;
      if (to) out.dateTo = to;
    } else {
      out.selectedDatetime = datetime;
    }
  }

  // Number(null) is 0, not NaN — check presence first so an absent param
  // isn't misread as an explicit 0.
  if (params.has('cloud_cover_max')) {
    const cloudCoverMax = Number(params.get('cloud_cover_max'));
    if (Number.isFinite(cloudCoverMax)) out.cloudCoverMax = cloudCoverMax;
  }

  // Legacy param name for the selected day — superseded by `datetime`
  // above, but still honored (and wins if both are present) for old links.
  const selectedDatetime = params.get('selected_datetime');
  if (selectedDatetime) out.selectedDatetime = selectedDatetime;

  const basemap = params.get('basemap');
  if (basemap) out.basemap = basemap;

  if (params.has('width')) {
    const width = Number(params.get('width'));
    if (Number.isFinite(width)) out.width = width;
  }

  const visualiseSettings = {};

  const preset = params.get('preset');
  if (preset) visualiseSettings.preset = preset;

  const vizMode = params.get('viz_mode');
  if (vizMode) visualiseSettings.vizMode = vizMode;

  const bands = params.get('bands');
  if (bands) {
    const [r, g, b] = bands.split('-');
    if (r && g && b) visualiseSettings.bands = { r, g, b };
  }

  const singleBand = params.get('single_band');
  if (singleBand) visualiseSettings.singleBand = singleBand;

  const indexBands = params.get('index_bands');
  if (indexBands) {
    const [a, b] = indexBands.split('-');
    if (a && b) visualiseSettings.indexBands = { a, b };
  }

  const viz = {};
  if (params.has('vmin')) {
    const v = Number(params.get('vmin'));
    if (Number.isFinite(v)) viz.vmin = v;
  }
  if (params.has('vmax')) {
    const v = Number(params.get('vmax'));
    if (Number.isFinite(v)) viz.vmax = v;
  }
  if (params.has('gamma')) {
    const v = Number(params.get('gamma'));
    if (Number.isFinite(v)) viz.gamma = v;
  }
  const format = params.get('format');
  if (format) viz.format = format;
  const colormap = params.get('colormap');
  if (colormap) viz.colormap = colormap;
  if (params.has('colormap_reversed')) viz.colormapReversed = params.get('colormap_reversed') === '1';
  if (Object.keys(viz).length) visualiseSettings.viz = viz;

  if (Object.keys(visualiseSettings).length) out.visualiseSettings = visualiseSettings;

  // Backward compat: links shared before the flat params above existed
  // carried one JSON blob instead. Only consulted when none of the flat
  // params supplied anything — the new format always wins.
  if (!out.visualiseSettings) {
    const legacy = params.get('visualise_settings');
    if (legacy) {
      try {
        out.visualiseSettings = JSON.parse(legacy);
      } catch {
        /* malformed/hand-edited param — ignore, fall back to defaults */
      }
    }
  }

  return out;
}

/**
 * Turns parseParams()'s output into a state patch — the merge shared by the
 * web app's URL restore and the CLI's --url. `currentViz` is the base `viz`
 * the URL's partial `viz` is merged onto, so omitted fields don't become
 * `undefined` and poison the vmin/vmax stretch with NaN. (basemap, bbox and
 * the selected day are applied by the caller — they need the map.)
 */
export function urlStateToPatch(urlState, currentViz) {
  const patch = {};
  if (urlState.dateFrom) patch.dateFrom = urlState.dateFrom;
  if (urlState.dateTo) patch.dateTo = urlState.dateTo;
  // A specific shared day with no explicit range: search just that day, not
  // the rolling default, which may no longer include it.
  if (!urlState.dateFrom && !urlState.dateTo && urlState.selectedDatetime) {
    patch.dateFrom = urlState.selectedDatetime;
    patch.dateTo = urlState.selectedDatetime;
  }
  if (urlState.cloudCoverMax !== undefined) patch.cloudCoverMax = urlState.cloudCoverMax;
  if (urlState.width !== undefined) patch.targetWidth = urlState.width;
  if (urlState.visualiseSettings) {
    const { viz, ...rest } = urlState.visualiseSettings;
    Object.assign(patch, rest);
    if (viz) patch.viz = { ...currentViz, ...viz };
  }
  return patch;
}

/**
 * A MapLibre-style `#zoom/lat/lng` camera that frames `bbox`, for links made
 * without a live map (the CLI). The app only restores a shared box if the
 * map is zoomed in enough to search (zoom 8+) with the box in view, since
 * scenes are looked up for the viewport — so without a camera in the link
 * it opens at the default view and finds nothing. Sized for a modest
 * viewport (a larger one just sees more around the box); zoom is floored
 * to two decimals so the box always fits.
 */
export function cameraHash([w, s, e, n], viewport = { width: 640, height: 480 }) {
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  // At zoom z the world is 512 * 2^z px wide (MapLibre's 512px tiles).
  const fracW = (e - w) / 360;
  const fracH = (mercY(n) - mercY(s)) / (2 * Math.PI);
  const fit = Math.log2(Math.min(viewport.width / (512 * fracW), viewport.height / (512 * fracH)));
  const zoom = Math.max(8, Math.floor(fit * 100) / 100);
  return `#${zoom}/${((s + n) / 2).toFixed(4)}/${((w + e) / 2).toFixed(4)}`;
}

/**
 * Builds the query params for the current shareable state, preserving any
 * existing params this app doesn't know about (`currentSearch`). Only
 * fields that differ from DEFAULT_STATE are written.
 */
export function buildParams(state, currentSearch) {
  const params = new URLSearchParams(currentSearch);
  const setOrDelete = (key, value, isDefault) => {
    if (isDefault) params.delete(key);
    else params.set(key, value);
  };

  if (state.drawnBbox) params.set('bbox', state.drawnBbox.map((n) => +n.toFixed(5)).join('_'));
  else params.delete('bbox');

  // The date range itself isn't stored — only the selected day is, as a
  // single-value `datetime` (no `/`, so parseParams can tell it apart from
  // the legacy range format above). On reload, main.js searches a
  // single-day window around it, which (unlike the search's own rolling
  // "last 30 days" default) still finds the shared item weeks or months
  // later regardless of the actual range the sharer had been browsing with.
  if (state.selectedDay) params.set('datetime', state.selectedDay);
  else params.delete('datetime');
  // Superseded by `datetime` above.
  params.delete('selected_datetime');

  setOrDelete('cloud_cover_max', String(state.cloudCoverMax), state.cloudCoverMax === DEFAULT_STATE.cloudCoverMax);

  setOrDelete('width', String(state.targetWidth), state.targetWidth === DEFAULT_STATE.targetWidth);
  setOrDelete('basemap', state.basemap, state.basemap === DEFAULT_STATE.basemap);
  setOrDelete('preset', state.preset, state.preset === DEFAULT_STATE.preset);
  setOrDelete('viz_mode', state.vizMode, state.vizMode === DEFAULT_STATE.vizMode);

  const b = state.bands, db = DEFAULT_STATE.bands;
  setOrDelete('bands', `${b.r}-${b.g}-${b.b}`, b.r === db.r && b.g === db.g && b.b === db.b);

  setOrDelete('single_band', state.singleBand, state.singleBand === DEFAULT_STATE.singleBand);

  const ib = state.indexBands, dib = DEFAULT_STATE.indexBands;
  setOrDelete('index_bands', `${ib.a}-${ib.b}`, ib.a === dib.a && ib.b === dib.b);

  const v = state.viz, dv = DEFAULT_STATE.viz;
  setOrDelete('vmin', String(v.vmin), v.vmin === dv.vmin);
  setOrDelete('vmax', String(v.vmax), v.vmax === dv.vmax);
  setOrDelete('gamma', String(v.gamma), v.gamma === dv.gamma);
  setOrDelete('format', v.format, v.format === dv.format);
  setOrDelete('colormap', v.colormap, v.colormap === dv.colormap);
  setOrDelete('colormap_reversed', v.colormapReversed ? '1' : '0', v.colormapReversed === dv.colormapReversed);

  // Superseded by the flat params above.
  params.delete('visualise_settings');

  return params;
}
