/**
 * Builds a minimal STAC Item describing how a Cogniscient export was produced.
 * Uses core STAC links (`derived_from`) for source-scene provenance:
 * https://github.com/radiantearth/stac-spec/blob/master/item-spec/item-spec.md
 */

import { parseParams } from './url-state.js';

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
    stac_extensions: ['https://stac-extensions.github.io/processing/v1.1.0/schema.json'],
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

/**
 * Inverse of buildStacProvenance: recovers what's needed to re-run an export
 * from one of its provenance documents — a state `patch` (box, day,
 * collection, bands, stretch, format), the output `width` (only recorded in
 * the reproduce link), and the `sourceHrefs` of the exact scenes used.
 */
export function parseStacProvenance(doc) {
  const vis = doc?.properties?.['cogniscient:visualisation'];
  if (!vis || !doc.bbox) throw new Error('not a Cogniscient provenance document (no bbox / cogniscient:visualisation)');
  const { mode, band, bands } = vis.selected_bands;
  const { vmin, vmax, gamma, colormap, colormap_reversed: colormapReversed } = vis.stretch;

  const patch = {
    drawnBbox: doc.bbox,
    selectedDay: doc.properties.datetime?.slice(0, 10) ?? null,
    vizMode: mode,
    // rgb exports don't record a colormap (it had no effect), so keep the default.
    viz: { vmin, vmax, gamma, format: vis.format, ...(colormap === undefined ? {} : { colormap, colormapReversed }) },
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
