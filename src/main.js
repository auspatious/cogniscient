import { area } from '@turf/area';
import { bboxPolygon } from '@turf/bbox-polygon';
import { state, set, subscribe, HARD_LIMIT_KM2 } from './state.js';
import { createMap, BASEMAPS, setBasemap, createToggleControl } from './map.js';
import { searchItems } from './stac.js';
import { addFootprintLayers, setFootprints, setSelected } from './footprint-layer.js';
import { createRectangleDraw } from './rectangle-draw.js';
import { groupByDay } from './mosaic.js';
import { streamComposite, renderRGBA, toBlob, toBlobURL, cropToValid, toGeoTIFFBlob } from './export.js';
import { outputSize } from './overviews.js';
import { placeName } from './geocode.js';
import { renderSearchPanel } from './ui/search-panel.js';
import { renderAreaPanel } from './ui/area-panel.js';
import { renderItemsPanel } from './ui/items-panel.js';
import { renderVisualisePanel } from './ui/visualise-panel.js';
import { renderExportPanel } from './ui/export-panel.js';
import { renderSharePanel } from './ui/share-panel.js';
import { renderStatusPanel } from './ui/status-panel.js';
import { buildStacProvenance } from './stac-provenance.js';
import { log } from './log.js';
import { parseParams, buildParams } from './url-state.js';

/* ── Map + panels ─────────────────────────────────────────────────────── */

// Restore shareable state from the URL. bbox/selected_datetime need the
// map's style to be loaded first (see the map.on('load', ...) handler
// below) — applied there. Everything else — including basemap, needed for
// the map's *initial* style — is safe to apply now, before the map/panels
// are created.
const urlState = parseParams(location.search);
{
  const patch = {};
  if (urlState.dateFrom) patch.dateFrom = urlState.dateFrom;
  if (urlState.dateTo) patch.dateTo = urlState.dateTo;
  // No explicit range in the URL, but a specific day was shared — search
  // just that day rather than the rolling 30-day default, which may no
  // longer include it by the time this link is opened.
  if (!urlState.dateFrom && !urlState.dateTo && urlState.selectedDatetime) {
    patch.dateFrom = urlState.selectedDatetime;
    patch.dateTo = urlState.selectedDatetime;
  }
  if (urlState.cloudCoverMax !== undefined) patch.cloudCoverMax = urlState.cloudCoverMax;
  if (urlState.width !== undefined) patch.targetWidth = urlState.width;
  if (urlState.basemap && BASEMAPS.some((b) => b.id === urlState.basemap)) patch.basemap = urlState.basemap;
  if (urlState.visualiseSettings) {
    // `viz` from the URL is only ever a partial object (each field is
    // written independently, only on deviation from default — see
    // url-state.js) — merge it onto the current default `viz`, don't
    // replace it outright, or the fields it omits become `undefined` and
    // poison the vmin/vmax stretch maths with NaN.
    const { viz, ...rest } = urlState.visualiseSettings;
    Object.assign(patch, rest);
    if (viz) patch.viz = { ...state.viz, ...viz };
  }
  if (Object.keys(patch).length) set(patch);
}

const map = createMap('map', state.basemap);
if (import.meta.env.DEV) {
  window.__map__ = map;
  window.__state__ = state;
  window.__set__ = set;
}

// Toggle button next to the zoom controls, cycling to the *other* basemap.
// Shows the CURRENT basemap (MAP/SAT) — click only updates state;
// setBasemap() itself happens in the subscribe below, so a URL-restored
// basemap and a click go through the same path.
function currentBasemap() {
  return BASEMAPS.find((b) => b.id === state.basemap) ?? BASEMAPS[0];
}
function nextBasemap() {
  const idx = BASEMAPS.findIndex((b) => b.id === state.basemap);
  return BASEMAPS[(idx + 1) % BASEMAPS.length];
}
const basemapControl = createToggleControl({
  label: () => currentBasemap().short,
  title: () => `${currentBasemap().label} — click to switch to ${nextBasemap().label}`,
  onClick: () => set({ basemap: nextBasemap().id }),
});
map.addControl(basemapControl, 'top-right');

let lastBasemap = state.basemap;
subscribe(() => {
  if (state.basemap === lastBasemap) return;
  lastBasemap = state.basemap;
  setBasemap(map, state.basemap);
  basemapControl.refresh();
});

// Toggle button for hiding/showing the preview overlay (to compare against
// the bare basemap) without discarding the cached fetch — a repaint from
// cache, not a re-fetch. Local UI state only, not shareable via URL.
let previewVisible = true;
function applyPreviewVisibility() {
  if (overlayId && map.getLayer(overlayId)) {
    map.setLayoutProperty(overlayId, 'visibility', previewVisible ? 'visible' : 'none');
  }
}
const previewControl = createToggleControl({
  label: () => (previewVisible ? 'ON' : 'OFF'),
  title: () => (previewVisible ? 'Preview visible — click to hide' : 'Preview hidden — click to show'),
  onClick: () => {
    previewVisible = !previewVisible;
    applyPreviewVisibility();
    previewControl.refresh();
  },
});
map.addControl(previewControl, 'top-right');

renderStatusPanel(document.getElementById('panel-status'));

// Surface otherwise-silent bugs in the Status panel instead of just the
// console, since that's the one place users can see when something broke.
window.addEventListener('error', (e) => log.err(`Unexpected error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => {
  log.err(`Unexpected error: ${e.reason?.message ?? e.reason}`);
});

renderSearchPanel(document.getElementById('panel-search'), { onChange: runSearch, map });
renderAreaPanel(document.getElementById('panel-area'), {
  onDraw: () => { log.info('Click-drag on the map to draw.'); draw.start(); },
  onClear: () => { draw.clear(); log.info('Cleared box.'); },
});
renderItemsPanel(document.getElementById('panel-items'), {
  onSelect: selectDay,
  onRedraw: redrawSelectedDay,
  isRedrawAvailable,
  map,
});
renderVisualisePanel(document.getElementById('panel-visualise'));
renderExportPanel(document.getElementById('panel-export'), { onDownload: download, onDownloadStac: downloadStac });
renderSharePanel(document.getElementById('panel-share'));

// 'style.load' fires on *every* style load, including a basemap switch —
// unlike 'load' below (fires once, ever). Switching basemap replaces the
// whole style, which wipes any source/layer not defined in the new
// style's own JSON — i.e. everything we add ourselves (footprints, drawn
// box, preview overlay) — so it all needs re-adding here every time.
map.on('style.load', () => {
  addFootprintLayers(map);
  if (state.drawnBbox) draw.setBbox(state.drawnBbox);
  syncFootprints();
  // The overlay source/layer is gone too; forget the stale id/url so the
  // next paint recreates them instead of trying to update what's missing.
  overlayId = null;
  overlayURL = null;
  if (cache) schedulePaint();
});

map.on('load', () => {
  mapReady = true;
  log.ok('Ready. Draw a box, pick a day, tweak the look, download.');
  // bbox/selected_datetime restored from a shared URL — reuses the exact
  // same path a real drag/click takes. Must happen after the map's style
  // has loaded: draw.setBbox() calls addSource/addLayer, which MapLibre
  // throws on if called too early — doing this at top-level module init
  // threw and aborted the rest of this file's synchronous setup, so
  // *nothing* loaded, not just the box.
  if (urlState.bbox) {
    draw.setBbox(urlState.bbox);
    onDrawnBbox({ bbox: urlState.bbox });
    if (urlState.selectedDatetime) set({ selectedDay: urlState.selectedDatetime });
  }
  runSearch();
});
map.on('moveend', () => runSearch(true));

/* ── STAC search ──────────────────────────────────────────────────────── */

let mapReady = false;
let searchAbort = null;
let searchTimer = null;
async function runSearch(debounce = false) {
  if (debounce) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(false), 250);
    return;
  }
  if (!mapReady) return;
  if (map.getZoom() < state.minSearchZoom) {
    setFootprints(map, []);
    set({ items: [], itemsByDay: [] });
    return;
  }
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  try {
    const items = await searchItems({
      bbox,
      dateFrom: state.dateFrom,
      dateTo: state.dateTo,
      cloudCoverMax: state.cloudCoverMax,
      collection: state.collection,
      signal: searchAbort.signal,
    });
    const itemsByDay = groupByDay(items, state.drawnBbox);
    // Never auto-clear the selection/preview from a search update — a
    // search is viewport-scoped, so panning away from the drawn box (or a
    // stricter cloud filter) can make the selected day vanish from
    // itemsByDay without the box's actual, already-rendered scenes having
    // changed at all. If it truly has no scenes left, its row just won't
    // appear in the list — but the rendered image stays untouched, and
    // redrawing the box (wherever it now is) recomputes fresh.
    set({ items, itemsByDay });
    syncFootprints();
    log.ok(`Search: ${items.length} item(s), ${itemsByDay.length} day(s).`);
  } catch (err) {
    if (err.name !== 'AbortError') log.err(`Search: ${err.message}`);
  }
}

/**
 * With a box drawn and a day picked, show only that day's footprints —
 * every scene found for that day, not just ones intersecting the box, each
 * tagged `_intersects` so the layer can colour the two differently.
 * Otherwise show everything from the current search.
 */
function syncFootprints() {
  const g = state.selectedDay ? state.itemsByDay.find((x) => x.day === state.selectedDay) : null;
  const selected = g
    ? g.items.map((item) => ({
      ...item,
      properties: { ...item.properties, _intersects: !g.intersectingIds || g.intersectingIds.has(item.id) },
    }))
    : [];
  setSelected(map, selected);
  setFootprints(map, g && state.drawnBbox ? [] : state.items);
}

/* ── Rectangle draw ───────────────────────────────────────────────────── */

function onDrawnBbox({ bbox }) {
  if (!bbox) {
    set({ drawnBbox: null, drawnAreaKm2: 0, itemsByDay: groupByDay(state.items, null), selectedDay: null });
    syncFootprints();
    invalidatePreview();
    return;
  }
  const areaKm2 = area(bboxPolygon(bbox)) / 1_000_000;
  const itemsByDay = groupByDay(state.items, bbox);
  const stillValid = state.selectedDay && itemsByDay.some((g) => g.day === state.selectedDay);
  set({
    drawnBbox: bbox,
    drawnAreaKm2: areaKm2,
    itemsByDay,
    selectedDay: stillValid ? state.selectedDay : null,
  });
  syncFootprints();
  invalidatePreview();
  if (areaKm2 > HARD_LIMIT_KM2) log.err(`Box ${areaKm2.toFixed(0)} km² — over ${HARD_LIMIT_KM2} km² limit.`);
  else log.info(`Box: ${areaKm2.toFixed(1)} km²`);
  placeName(bbox).then((place) => { if (place) log.info(`Region: ${place}`); });
  if (stillValid) startFetch();
}

const draw = createRectangleDraw(map, onDrawnBbox);

/* ── Day selection ────────────────────────────────────────────────────── */

function selectDay(day) {
  set({ selectedDay: day });
  syncFootprints();
  invalidatePreview();
  if (!state.drawnBbox) {
    log.info(`Selected ${day}. Draw a rectangle to load a preview.`);
    return;
  }
  log.info(`Selected ${day}.`);
  startFetch();
}

/* ── Preview: fetch → cache → paint ───────────────────────────────────── */

let cache = null;         // { key, recipeKey, arrays }
let inFlightKey = null;   // string
let fetchAbort = null;    // AbortController for the in-flight COG reads
let overlayId = null;
let overlayURL = null;

// bands/singleBand/indexBands per vizMode → the fetch inputs for that mode.
function activeBands() {
  if (state.vizMode === 'single') return { band: state.singleBand };
  if (state.vizMode === 'index') return state.indexBands;
  return state.bands;
}

// Filename-friendly description of what's actually in the image, e.g.
// "rgb-red-green-blue", "single-nir", "index-nir-red".
function bandsSlug() {
  const b = activeBands();
  if (state.vizMode === 'single') return `single-${b.band}`;
  if (state.vizMode === 'index') return `index-${b.a}-${b.b}`;
  return `rgb-${b.r}-${b.g}-${b.b}`;
}

// The "recipe" a redraw is driven by — everything the user deliberately
// chose (day/box/size/look). Changing any of this always redraws.
function sceneRecipeKey() {
  if (!state.drawnBbox || !state.selectedDay) return null;
  const bandsKey = Object.values(activeBands()).join(',');
  return `${state.selectedDay}|${state.drawnBbox.join(',')}|${state.targetWidth}|${state.vizMode}|${bandsKey}`;
}

function sceneKey() {
  const recipe = sceneRecipeKey();
  if (!recipe) return null;
  const g = state.itemsByDay.find((x) => x.day === state.selectedDay);
  if (!g) return null;
  // renderItems (not items — that also holds non-intersecting scenes shown
  // just for context) are what actually get composited, so their ids are
  // what should mark the cache stale. Folded in so a search that adds/
  // removes an intersecting scene (e.g. panning, a cloud-filter change) is
  // visible here — but that alone doesn't redraw; see the "Redraw" button
  // wiring below.
  const ids = g.renderItems.map((i) => i.id).join(';');
  return `${recipe}|${ids}`;
}

function invalidatePreview() {
  cache = null;
  inFlightKey = null;
  fetchAbort?.abort();
  fetchAbort = null;
  if (overlayId) {
    if (map.getLayer(overlayId)) map.removeLayer(overlayId);
    if (map.getSource(overlayId)) map.removeSource(overlayId);
    overlayId = null;
  }
  if (overlayURL) { URL.revokeObjectURL(overlayURL); overlayURL = null; }
}

async function startFetch() {
  const key = sceneKey();
  const recipeKey = sceneRecipeKey();
  if (!key) return;
  if (state.drawnAreaKm2 > HARD_LIMIT_KM2) return;
  if (cache?.key === key) { schedulePaint(); return; }
  if (inFlightKey === key) return;

  const bbox = state.drawnBbox;
  const group = state.itemsByDay.find((g) => g.day === state.selectedDay);
  if (!group) return;

  const size = outputSize(bbox, state.targetWidth, state.nativeGSD);
  log.info(`Fetching ${group.renderItems.length} item(s) → ${size.width}×${size.height} px`);

  inFlightKey = key;
  fetchAbort?.abort();
  fetchAbort = new AbortController();
  set({ loading: { active: true, done: 0, total: group.renderItems.length, message: 'Preparing' } });
  showSpinner(true);

  try {
    await streamComposite({
      items: group.renderItems,
      drawnBbox: bbox,
      mode: state.vizMode,
      bands: activeBands(),
      width: size.width,
      height: size.height,
      signal: fetchAbort.signal,
      onLog: log.info,
      onPartial: (arrays, itemIdx, itemCount) => {
        if (sceneKey() !== key) return;
        cache = { key, recipeKey, arrays };
        set({ loading: { active: true, done: itemIdx, total: itemCount, message: `Streaming ${itemIdx}/${itemCount}` } });
        schedulePaint();
      },
    });
    if (sceneKey() === key) {
      schedulePaint();
      log.ok('Preview ready.');
    }
  } catch (err) {
    log.err(`Preview failed: ${err.message}`);
  } finally {
    if (inFlightKey === key) inFlightKey = null;
    set({ loading: { active: false, done: 0, total: 0, message: '' } });
    showSpinner(false);
  }
}

/* ── Paint (rAF-throttled) ────────────────────────────────────────────── */

let paintScheduled = false;
function schedulePaint() {
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(async () => {
    paintScheduled = false;
    if (!cache) return;
    const img = renderRGBA(cache.arrays, state.viz, state.vizMode);
    await paintOverlay(img, state.drawnBbox);
  });
}

async function paintOverlay(img, bbox) {
  const url = await toBlobURL(img, 'png');
  const [w, s, e, n] = bbox;
  const corners = [[w, n], [e, n], [e, s], [w, s]];
  if (overlayId && map.getSource(overlayId)) {
    // Update image and coordinates in one call — updateImage's image load is
    // async, so calling setCoordinates separately right after would apply
    // the new geometry to the still-old texture before the new pixels
    // arrive, then get redundantly recomputed once they do.
    map.getSource(overlayId).updateImage({ url, coordinates: corners });
  } else {
    overlayId = 'preview-overlay';
    map.addSource(overlayId, { type: 'image', url, coordinates: corners });
    // Insert below the drawn-box layers so the box outline always stays on
    // top of the preview image, not hidden underneath it. Respects the
    // preview visibility toggle so a repaint (viz change, basemap switch)
    // doesn't silently re-show a preview the user hid.
    map.addLayer({
      id: overlayId,
      type: 'raster',
      source: overlayId,
      layout: { visibility: previewVisible ? 'visible' : 'none' },
      paint: { 'raster-opacity': 1.0, 'raster-fade-duration': 0 },
    }, 'draw-box-fill');
  }
  const prev = overlayURL;
  overlayURL = url;
  if (prev) setTimeout(() => URL.revokeObjectURL(prev), 100);
}

/* ── Reactive glue: viz changes → repaint. size changes → refetch. ────── */

let lastViz = JSON.stringify(state.viz);
let lastRecipeKey = sceneRecipeKey();
let refetchTimer = null;
subscribe((s) => {
  const viz = JSON.stringify(s.viz);
  if (viz !== lastViz) {
    lastViz = viz;
    // Repaint from whatever's cached as long as it's still for the current
    // deliberate recipe (day/box/size/mode/bands) — NOT the full sceneKey,
    // which also encodes the source-item ids and drifts on every
    // background search (e.g. panning), well before the user does
    // anything that should actually stop a look-only change from
    // repainting the (still perfectly valid) cached pixels.
    if (cache?.recipeKey === sceneRecipeKey()) schedulePaint();
  }

  // Auto-fetch when either: the recipe deliberately changed (new day/box/
  // size/look), or nothing is rendered/in-flight for it yet — e.g. a
  // restored bbox+selected_datetime from a shared URL, whose scenes only
  // become known once the initial search resolves (recipeKey itself
  // doesn't change at that point, only itemsByDay does). A search finding
  // new/removed scenes for an *already-rendered* day (e.g. from panning)
  // matches neither condition — isRedrawAvailable() below drives a manual
  // "Redraw" button in the items panel for that case instead.
  const recipeKey = sceneRecipeKey();
  const recipeChanged = recipeKey !== lastRecipeKey;
  lastRecipeKey = recipeKey;
  const key = sceneKey();
  if (key && cache?.key !== key && inFlightKey !== key && (recipeChanged || !cache)) {
    // Debounce so dragging the size slider doesn't spawn many fetches.
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(startFetch, 300);
  }
});

// True once the scenes covering the selected day (post-search) differ from
// what's actually cached/rendered — e.g. panning revealed another scene.
// Read at paint time by the items panel (passed in below, not imported —
// items-panel.js is imported by this file); not stored in state, so
// nothing here ever calls `set()` from inside a subscriber.
function isRedrawAvailable() {
  const key = sceneKey();
  return !!(cache && key && cache.key !== key);
}

function redrawSelectedDay() {
  startFetch();
}

// Keep the URL shareable — debounced so continuous interactions (slider
// drags, typing) don't spam the address bar. Replaces history rather than
// pushing, so it never pollutes the back button.
let urlSyncTimer = null;
subscribe(() => {
  clearTimeout(urlSyncTimer);
  urlSyncTimer = setTimeout(() => {
    const params = buildParams(state, location.search);
    history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash}`);
  }, 400);
});

/* ── Download = save current preview data. No re-fetch. ───────────────── */

function extFor(fmt) {
  return fmt === 'jpg' ? 'jpg' : fmt === 'tif' ? 'tif' : 'png';
}

// Encodes the current cache into the format-appropriate blob. Shared by
// download() and downloadStac() so the metadata's referenced/downloaded
// filename can exactly match the real export's (same width/place), instead
// of a guess — TIF carries raw reflectance DN / index values, not the
// stretched display pixels; no vmin/vmax/gamma/colormap baked in.
async function buildExportBlob(fmt) {
  if (fmt === 'tif') {
    const { blob, width, height } = toGeoTIFFBlob(cache.arrays, state.drawnBbox, state.vizMode);
    return { blob, outWidth: width, outHeight: height };
  }
  const rendered = renderRGBA(cache.arrays, state.viz, state.vizMode);
  const img = cropToValid(rendered, cache.arrays.mask);
  const blob = await toBlob(img, fmt);
  return { blob, outWidth: img.width, outHeight: img.height };
}

async function exportBaseFilename(outWidth) {
  const place = await placeName(state.drawnBbox);
  const suffix = place ? `-${place}` : '';
  return `cogniscient-${state.selectedDay}-${bandsSlug()}-${outWidth}px${suffix}`;
}

async function download() {
  if (!cache) return log.warn('No preview to save.');
  try {
    const fmt = state.viz.format;
    const { blob, outWidth, outHeight } = await buildExportBlob(fmt);
    const base = await exportBaseFilename(outWidth);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base}.${extFor(fmt)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    log.ok(`Saved ${outWidth}×${outHeight} px ${fmt.toUpperCase()}`);
  } catch (err) {
    log.err(`Save failed: ${err.message}`);
  }
}

async function downloadStac() {
  if (!state.drawnBbox || !state.selectedDay) return log.warn('Select a box and day first.');
  if (!cache) return log.warn('No preview to save — fetch one first.');
  const group = state.itemsByDay.find((g) => g.day === state.selectedDay);
  if (!group) return log.warn('No source scenes found for this day.');

  try {
    const fmt = state.viz.format;
    // Same encode + base-filename path download() uses, so the metadata's
    // asset href and its own downloaded filename exactly match the real
    // exported image/GeoTIFF's — the blob itself is discarded here.
    const { outWidth } = await buildExportBlob(fmt);
    const base = await exportBaseFilename(outWidth);

    const reproduceUrl = `${location.origin}${location.pathname}?${buildParams(state, location.search).toString()}${location.hash}`;
    const doc = buildStacProvenance({
      appState: state,
      sourceItems: group.renderItems,
      reproduceUrl,
      exportFilename: `${base}.${extFor(fmt)}`,
    });
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base}.stac-item.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    log.ok(`Saved metadata (${group.renderItems.length} source scene(s)).`);
  } catch (err) {
    log.err(`Metadata save failed: ${err.message}`);
  }
}

/* ── Spinner over drawn box ───────────────────────────────────────────── */

const spinnerEl = document.getElementById('map-spinner');
function showSpinner(on) {
  if (!spinnerEl) return;
  spinnerEl.classList.toggle('on', on);
  if (on) positionSpinner();
}
function positionSpinner() {
  if (!spinnerEl || !state.drawnBbox) return;
  const [w, s, e, n] = state.drawnBbox;
  const p = map.project([(w + e) / 2, (s + n) / 2]);
  spinnerEl.style.left = `${p.x}px`;
  spinnerEl.style.top = `${p.y}px`;
}
map.on('render', () => { if (spinnerEl?.classList.contains('on')) positionSpinner(); });
