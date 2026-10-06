/**
 * Builds a minimal STAC Item describing how a Cogniscient export was produced.
 * Uses core STAC links (`derived_from`) for source-scene provenance:
 * https://github.com/radiantearth/stac-spec/blob/master/item-spec/item-spec.md
 */

import { parseParams } from './url-state.js';

const RENDER_EXT = 'https://stac-extensions.github.io/render/v2.1.0/schema.json';

export const APP_URL = 'https://cogniscient.auspatious.com/';

// Per STAC's asset roles best practice — 'data' is the raw analysable
// asset, 'visual' is a rendered image meant for viewing, not analysis:
// https://github.com/radiantearth/stac-spec/blob/master/best-practices.md#asset-roles
function assetForFormat(format) {
  if (format === 'tif') return { role: 'data', type: 'image/tiff; application=geotiff' };
  if (format === 'jpg') return { role: 'visual', type: 'image/jpeg' };
  return { role: 'visual', type: 'image/png' };
}

function bboxGeometry([w, s, e, n]) {
  return {
    type: 'Polygon',
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
  };
}

function activeBandSelection(appState) {
  if (appState.vizMode === 'single') return { mode: 'single', band: appState.singleBand };
  if (appState.vizMode === 'index') {
    return {
      mode: 'index',
      bands: { ...appState.indexBands },
      expression: '(a - b) / (a + b)',
    };
  }
  return { mode: 'rgb', bands: { ...appState.bands } };
}

function selfHref(item) {
  return item?.links?.find((l) => l.rel === 'self')?.href ?? null;
}

// The same settings as a STAC render extension object, so other tools (STAC
// Browser, titiler) can apply them. Spec: https://github.com/stac-extensions/render
// Strictly `assets` should be keys of this item; here they name the source
// scenes' assets (see derived_from links). Gamma only fits rgb (color_formula).
function buildRender(appState) {
  const { vizMode, viz } = appState;
  const rescale = (n) => Array.from({ length: n }, () => [viz.vmin, viz.vmax]);
  const colormap = viz.colormap === 'gray' && !viz.colormapReversed
    ? {}
    : { colormap_name: viz.colormap + (viz.colormapReversed ? '_r' : '') };
  if (vizMode === 'rgb') {
    const assets = [appState.bands.r, appState.bands.g, appState.bands.b];
    return {
      assets,
      rescale: rescale(3),
      ...(viz.gamma === 1 ? {} : { color_formula: `gamma rgb ${viz.gamma}` }),
    };
  }
  if (vizMode === 'single') return { assets: [appState.singleBand], rescale: rescale(1), ...colormap };
  const { a, b } = appState.indexBands;
  return {
    assets: [a, b],
    asset_as_band: true,
    expression: `(${a}-${b})/(${a}+${b})`,
    rescale: rescale(1),
    ...colormap,
  };
}

export function buildStacProvenance({ appState, sourceItems, reproduceUrl, exportFilename }) {
  const bbox = appState.drawnBbox;
  const datetime = appState.selectedDay ? `${appState.selectedDay}T00:00:00Z` : null;
  const created = new Date().toISOString();
  const selectedBands = activeBandSelection(appState);
  const format = appState.viz.format;

  const links = [
    { rel: 'about', href: APP_URL, type: 'text/html', title: 'Generated with Cogniscient' },
    // Without `type`, STAC Browser assumes JSON, fails to parse this HTML
    // page, and won't render the link as clickable.
    ...(reproduceUrl ? [{ rel: 'alternate', href: reproduceUrl, type: 'text/html', title: 'Reproduce this export in Cogniscient' }] : []),
    ...sourceItems
      .map((item) => {
        const href = selfHref(item);
        return href
          ? {
            rel: 'derived_from',
            href,
            type: 'application/geo+json',
            title: item.id,
          }
          : null;
      })
      .filter(Boolean),
  ];

  // rgb mode ignores colormap/colormapReversed entirely (see FEATURES.md) —
  // don't record settings that had no effect on the export.
  const stretch = {
    vmin: appState.viz.vmin,
    vmax: appState.viz.vmax,
    gamma: appState.viz.gamma,
    ...(appState.vizMode === 'rgb' ? {} : {
      colormap: appState.viz.colormap,
      colormap_reversed: appState.viz.colormapReversed,
    }),
  };

  const assets = exportFilename
    ? (() => {
      const { role, type } = assetForFormat(format);
      return {
        [role]: {
          href: exportFilename,
          type,
          roles: [role],
          title: role === 'data' ? 'Exported GeoTIFF' : 'Exported image',
        },
      };
    })()
    : {};

  return {
    stac_version: '1.0.0',
    stac_extensions: ['https://stac-extensions.github.io/processing/v1.1.0/schema.json', RENDER_EXT],
    type: 'Feature',
    id: `cogniscient-${appState.selectedDay}-${created}`,
    bbox,
    geometry: bbox ? bboxGeometry(bbox) : null,
    properties: {
      datetime,
      created,
      // A free-text description, per the processing extension schema — NOT
      // an array (item ids are already captured correctly, as structured
      // data, in the derived_from links above).
      'processing:lineage': sourceItems.length
        ? `Composited from ${sourceItems.length} Sentinel-2 scene(s): ${sourceItems.map((item) => item.id).join(', ')}`
        : 'No source scenes recorded.',
      'cogniscient:collection': appState.collection,
      renders: { cogniscient: buildRender(appState) },
      'cogniscient:visualisation': {
        selected_bands: selectedBands,
        stretch,
        format,
      },
    },
    links,
    assets,
  };
}

// Best-effort reading of a render extension object (first one in the item)
// into the shape of `cogniscient:visualisation`. Handles what buildRender
// writes; returns undefined for anything else (e.g. other expressions).
function visFromRender(renders) {
  const r = Object.values(renders ?? {})[0];
  const [vmin, vmax] = r?.rescale?.[0] ?? [];
  if (!r?.assets || vmin === undefined) return undefined;
  const cm = r.colormap_name;
  const stretch = {
    vmin,
    vmax,
    gamma: Number(r.color_formula?.match(/gamma rgb ([\d.]+)/)?.[1] ?? 1),
    ...(cm ? { colormap: cm.replace(/_r$/, ''), colormap_reversed: cm.endsWith('_r') } : {}),
  };
  if (r.expression) {
    const m = r.expression.match(/^\(\s*(\w+)\s*-\s*(\w+)\s*\)\s*\/\s*\(\s*\1\s*\+\s*\2\s*\)$/);
    if (!m) return undefined;
    return { selected_bands: { mode: 'index', bands: { a: m[1], b: m[2] } }, stretch };
  }
  if (r.assets.length === 1) return { selected_bands: { mode: 'single', band: r.assets[0] }, stretch };
  if (r.assets.length === 3) {
    const [rr, g, b] = r.assets;
    return { selected_bands: { mode: 'rgb', bands: { r: rr, g, b } }, stretch };
  }
  return undefined;
}

/**
 * Inverse of buildStacProvenance: recovers what's needed to re-run an export
 * from one of its provenance documents — a state `patch` (box, day,
 * collection, bands, stretch, format), the output `width` (only recorded in
 * the reproduce link), and the `sourceHrefs` of the exact scenes used.
 */
export function parseStacProvenance(doc) {
  const vis = doc?.properties?.['cogniscient:visualisation'] ?? visFromRender(doc?.properties?.renders);
  if (!vis || !doc.bbox) throw new Error('not a Cogniscient provenance document (no bbox / cogniscient:visualisation or usable render)');
  const { mode, band, bands } = vis.selected_bands;
  const { vmin, vmax, gamma, colormap, colormap_reversed: colormapReversed } = vis.stretch;

  const patch = {
    drawnBbox: doc.bbox,
    selectedDay: doc.properties.datetime?.slice(0, 10) ?? null,
    vizMode: mode,
    // rgb exports don't record a colormap (it had no effect), so keep the default.
    viz: { vmin, vmax, gamma, ...(vis.format ? { format: vis.format } : {}), ...(colormap === undefined ? {} : { colormap, colormapReversed }) },
  };
  if (doc.properties['cogniscient:collection']) patch.collection = doc.properties['cogniscient:collection'];
  if (mode === 'single') patch.singleBand = band;
  else if (mode === 'index') patch.indexBands = { a: bands.a, b: bands.b };
  else patch.bands = { ...bands };

  let width;
  try {
    const reproduce = doc.links?.find((l) => l.rel === 'alternate')?.href;
    if (reproduce) width = parseParams(new URL(reproduce).search).width;
  } catch { /* malformed link: fall back to the default width */ }

  const sourceHrefs = (doc.links ?? []).filter((l) => l.rel === 'derived_from').map((l) => l.href);
  return { patch, width, sourceHrefs };
}
