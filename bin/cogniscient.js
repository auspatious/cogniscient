#!/usr/bin/env node
/* Cogniscient CLI: the web app's export pipeline, headless — the very same
   modules (STAC search, COG reads, mosaic, stretch, PNG/JPG/GeoTIFF encode). */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { DEFAULT_STATE, DEFAULT_COLLECTION, DEFAULT_NATIVE_GSD, HARD_LIMIT_KM2, defaultDateRange } from '../src/state.js';
import { searchItems } from '../src/stac.js';
import { groupByDay } from '../src/mosaic.js';
import { outputSize } from '../src/overviews.js';
import { streamComposite, renderRGBA, cropToValid, toBlob, toGeoTIFFBlob } from '../src/export.js';
import { parseParams, buildParams, urlStateToPatch } from '../src/url-state.js';
import { activeBands, exportBaseFilename } from '../src/filename.js';
import { buildStacProvenance, parseStacProvenance, APP_URL } from '../src/stac-provenance.js';
import { COLORMAPS } from '../src/colormap.js';

// export.js builds ImageData at call time; Node has no such global.
globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height ?? data.length / 4 / width;
  }
};

const USAGE = `Usage: cogniscient --bbox W,S,E,N [options]
       cogniscient --url "<cogniscient share link>" [options]
       cogniscient --reproduce path/to/export.stac.json [options]

Area & day
  --bbox W,S,E,N        Box in WGS-84 degrees (west,south,east,north)
  --url URL             A Cogniscient share link (or bare query string); its
                        box, day and look become the defaults for the flags below
  --reproduce FILE      Re-run an export from its STAC provenance JSON, using the
                        exact scenes it records (flags like --format still override)
  --date YYYY-MM-DD     Acquisition day to export
  --date-from/--date-to Search window when --date is omitted (default: last 30 days)
  --cloud-cover-max N   Max scene cloud cover % (default ${DEFAULT_STATE.cloudCoverMax})
  --list-days           Print the days found (cloud, coverage) and exit

Look
  --mode rgb|single|index  (default ${DEFAULT_STATE.vizMode})
  --bands R,G,B         Asset keys for rgb mode (default ${Object.values(DEFAULT_STATE.bands)})
  --single-band NAME    Asset key for single mode (default ${DEFAULT_STATE.singleBand})
  --index-bands A,B     (A - B) / (A + B) for index mode (default ${Object.values(DEFAULT_STATE.indexBands)})
  --vmin N --vmax N --gamma N   Stretch; use = for negatives: --vmin=-0.2 (default ${DEFAULT_STATE.viz.vmin} ${DEFAULT_STATE.viz.vmax} ${DEFAULT_STATE.viz.gamma})
  --colormap ID         single/index only: ${COLORMAPS.map((c) => c.id).join(', ')}
  --colormap-reversed   Flip the colour ramp

Output
  --width N             Output pixel width, capped at native 10 m/px (default ${DEFAULT_STATE.targetWidth})
  --format png|jpg|tif  (default ${DEFAULT_STATE.viz.format}; tif = raw values, georeferenced)
  --out PATH            Output file (default: cogniscient-<day>-<bands>-<width>px-<place>.<ext>)
  --stac                Also write <out>.stac.json provenance
  -h, --help
`;

const fail = (msg) => {
  console.error(`cogniscient: ${msg}`);
  process.exit(1);
};
const log = (msg) => console.error(msg);

let o;
try {
  ({ values: o } = parseArgs({
  options: {
    bbox: { type: 'string' },
    url: { type: 'string' },
    reproduce: { type: 'string' },
    date: { type: 'string' },
    'date-from': { type: 'string' },
    'date-to': { type: 'string' },
    'cloud-cover-max': { type: 'string' },
    'list-days': { type: 'boolean' },
    mode: { type: 'string' },
    bands: { type: 'string' },
    'single-band': { type: 'string' },
    'index-bands': { type: 'string' },
    vmin: { type: 'string' },
    vmax: { type: 'string' },
    gamma: { type: 'string' },
    colormap: { type: 'string' },
    'colormap-reversed': { type: 'boolean' },
    width: { type: 'string' },
    format: { type: 'string' },
    out: { type: 'string' },
    stac: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  }));
} catch (err) {
  fail(`${err.message}\n(negative values need an equals sign, e.g. --vmin=-0.2)`);
}

if (o.help) {
  console.log(USAGE);
  process.exit(0);
}

const num = (name, v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} must be a number, got "${v}"`);
  return n;
};
const list = (name, v, n) => {
  const parts = v.split(',');
  if (parts.length !== n || parts.some((p) => !p)) fail(`--${name} needs ${n} comma-separated values, got "${v}"`);
  return parts;
};

/* ── Build the state the web app would have: defaults → --url → flags ──── */

const s = {
  ...defaultDateRange(),
  collection: DEFAULT_COLLECTION,
  nativeGSD: DEFAULT_NATIVE_GSD,
  drawnBbox: null,
  selectedDay: null,
  ...DEFAULT_STATE,
  bands: { ...DEFAULT_STATE.bands },
  indexBands: { ...DEFAULT_STATE.indexBands },
  viz: { ...DEFAULT_STATE.viz },
};

if (o.url) {
  let search;
  try { search = new URL(o.url).search; } catch { search = o.url; }
  const fromUrl = parseParams(search);
  Object.assign(s, urlStateToPatch(fromUrl, s.viz));
  if (fromUrl.bbox) s.drawnBbox = fromUrl.bbox;
  if (fromUrl.selectedDatetime) s.selectedDay = fromUrl.selectedDatetime;
}

let sourceHrefs = null;
if (o.reproduce) {
  let parsed;
  try {
    parsed = parseStacProvenance(JSON.parse(readFileSync(o.reproduce, 'utf8')));
  } catch (err) {
    fail(`can't read ${o.reproduce}: ${err.message}`);
  }
  const { viz, ...rest } = parsed.patch;
  Object.assign(s, rest);
  s.viz = { ...s.viz, ...viz };
  if (parsed.width) s.targetWidth = parsed.width;
  sourceHrefs = parsed.sourceHrefs;
  if (!sourceHrefs.length) fail(`${o.reproduce} records no source scenes (derived_from links) to reproduce from`);
}

if (o.bbox) {
  s.drawnBbox = list('bbox', o.bbox, 4).map((v) => num('bbox', v));
  const [w, so, e, n] = s.drawnBbox;
  if (!(w < e && so < n && so >= -90 && n <= 90)) fail('--bbox must be west,south,east,north with west < east and south < north');
}
if (!s.drawnBbox) fail('need --bbox (or a --url containing one). Try --help.');

if (o.date) {
  s.dateFrom = s.dateTo = s.selectedDay = o.date;
} else {
  if (o['date-from']) s.dateFrom = o['date-from'];
  if (o['date-to']) s.dateTo = o['date-to'];
}
if (o['cloud-cover-max']) s.cloudCoverMax = num('cloud-cover-max', o['cloud-cover-max']);
if (o.width) s.targetWidth = num('width', o.width);
if (o.mode) {
  if (!['rgb', 'single', 'index'].includes(o.mode)) fail('--mode must be rgb, single or index');
  s.vizMode = o.mode;
}
if (o.bands) {
  const [r, g, b] = list('bands', o.bands, 3);
  s.bands = { r, g, b };
}
if (o['single-band']) s.singleBand = o['single-band'];
if (o['index-bands']) {
  const [a, b] = list('index-bands', o['index-bands'], 2);
  s.indexBands = { a, b };
}
if (o.vmin) s.viz.vmin = num('vmin', o.vmin);
if (o.vmax) s.viz.vmax = num('vmax', o.vmax);
if (o.gamma) s.viz.gamma = num('gamma', o.gamma);
if (o.colormap) {
  if (o.colormap !== 'gray' && !COLORMAPS.some((c) => c.id === o.colormap)) fail(`unknown --colormap "${o.colormap}"`);
  s.viz.colormap = o.colormap;
}
if (o['colormap-reversed']) s.viz.colormapReversed = true;
if (o.format) s.viz.format = o.format;
if (!['png', 'jpg', 'tif'].includes(s.viz.format)) fail(`--format must be png, jpg or tif, got "${s.viz.format}"`);

/* ── Scenes: the exact ones a provenance doc names, or a fresh search ──── */

let group;
if (sourceHrefs) {
  log(`Fetching ${sourceHrefs.length} source scene record(s)…`);
  const renderItems = await Promise.all(sourceHrefs.map(async (href) => {
    const res = await fetch(href);
    if (!res.ok) fail(`couldn't fetch source scene ${href}: ${res.status} ${res.statusText}`);
    return res.json();
  }));
  group = { day: s.selectedDay, renderItems };
} else {
  log(`Searching ${s.collection} ${s.dateFrom} → ${s.dateTo} (cloud ≤ ${s.cloudCoverMax}%)…`);
  const items = await searchItems({
    bbox: s.drawnBbox,
    dateFrom: s.dateFrom,
    dateTo: s.dateTo,
    cloudCoverMax: s.cloudCoverMax,
    collection: s.collection,
  });
  const days = groupByDay(items, s.drawnBbox);
  if (!days.length) fail('no scenes cover that box in that window. Widen --date-from/--date-to or raise --cloud-cover-max.');

  const dayTable = days
    .map((g) => `  ${g.day}  cloud ${g.meanCloud?.toFixed(1) ?? '?'}%  coverage ${g.coverage?.toFixed(0) ?? '?'}%  scenes ${g.renderItems.length}`)
    .join('\n');

  if (o['list-days']) {
    console.log(dayTable);
    process.exit(0);
  }

  if (s.selectedDay) {
    group = days.find((g) => g.day === s.selectedDay);
    if (!group) fail(`no scenes on ${s.selectedDay}. Days found:\n${dayTable}`);
  } else {
    // The web app has a human pick from the list; headless, take the clearest day.
    group = days.reduce((best, g) => ((g.meanCloud ?? 100) < (best.meanCloud ?? 100) ? g : best));
    s.selectedDay = group.day;
    log(`No --date given: using ${group.day} (lowest cloud, ${group.meanCloud?.toFixed(1)}%). --list-days shows the others.`);
  }
}

/* ── Composite + render ─────────────────────────────────────────────────── */

const { width, height, widthMeters, heightMeters } = outputSize(s.drawnBbox, s.targetWidth, s.nativeGSD);
if ((widthMeters * heightMeters) / 1e6 > HARD_LIMIT_KM2) fail(`box is over the ${HARD_LIMIT_KM2} km² limit`);
log(`Compositing ${group.renderItems.length} scene(s) at ${width}×${height}px…`);

const arrays = await streamComposite({
  items: group.renderItems,
  drawnBbox: s.drawnBbox,
  mode: s.vizMode,
  bands: activeBands(s),
  width,
  height,
  onPartial: (_, done, total) => log(`  ${done}/${total} scenes merged`),
  onLog: log,
});
if (!arrays.mask.some(Boolean)) fail('no valid pixels: every scene failed to read (see messages above).');

const img = cropToValid(renderRGBA(arrays, s.viz, s.vizMode), arrays.mask);
const fmt = s.viz.format;
const outPath = o.out ?? `${await exportBaseFilename(s, img.width)}.${fmt}`;

const blob = fmt === 'tif' ? toGeoTIFFBlob(arrays, s.drawnBbox, s.vizMode).blob : await toBlob(img, fmt);
writeFileSync(outPath, Buffer.from(await blob.arrayBuffer()));
log(`Wrote ${outPath} (${fmt === 'tif' ? 'raw GeoTIFF' : `${img.width}×${img.height}px ${fmt.toUpperCase()}`})`);

if (o.stac) {
  const doc = buildStacProvenance({
    appState: s,
    sourceItems: group.renderItems,
    reproduceUrl: `${APP_URL}?${buildParams(s, '').toString()}`,
    exportFilename: basename(outPath),
  });
  writeFileSync(`${outPath}.stac.json`, JSON.stringify(doc, null, 2));
  log(`Wrote ${outPath}.stac.json`);
}

// geotiff's decoder worker pool would otherwise keep the process alive.
process.exit(0);
