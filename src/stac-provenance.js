/**
 * Builds a minimal STAC Item describing how a Cogniscient export was produced.
 * Uses core STAC links (`derived_from`) for source-scene provenance:
 * https://github.com/radiantearth/stac-spec/blob/master/item-spec/item-spec.md
 */

const APP_URL = 'https://cogniscient.auspatious.com/';

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
