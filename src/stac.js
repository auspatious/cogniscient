/**
 * STAC client for Earth Search v1 (element84).
 * https://earth-search.aws.element84.com/v1/
 *
 * We POST /search with the current map bbox, requested date range, cloud cover
 * filter, and target collection. The response items are plain GeoJSON with
 * an `assets` dict that includes the RGB COGs.
 */

const SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search';

// Exact-match cache keyed by search params, so panning back over an
// already-searched extent (or toggling the basemap, or an undo-ish
// back-and-forth) doesn't refire the query. Caches the in-flight promise,
// not just the eventual result, so two calls for the same key made before
// the first resolves also collapse into one fetch. Deliberately not a
// fuzzy/tile-snapped cache — moveend bboxes are essentially never
// bit-identical across two different pans, so that would need real
// partial-coverage bookkeeping to help at all; this only needs to catch
// genuine repeat views. No TTL/eviction: entries are small and bounded by
// how many distinct exact viewports a session actually revisits.
const cache = new Map();

function cacheKey({ bbox, dateFrom, dateTo, cloudCoverMax, collection }) {
  // Rounded to absorb float noise from repeated getBounds() calls at the
  // identical pixel viewport — not a coarse/tile-snapping round.
  const b = bbox.map((v) => v.toFixed(5)).join(',');
  return `${b}|${dateFrom}|${dateTo}|${cloudCoverMax}|${collection}`;
}

export async function searchItems({
  bbox,
  dateFrom,
  dateTo,
  cloudCoverMax,
  collection,
  limit = 100,
  signal,
}) {
  const key = cacheKey({ bbox, dateFrom, dateTo, cloudCoverMax, collection });
  if (cache.has(key)) return cache.get(key);

  const promise = fetchItems({ bbox, dateFrom, dateTo, cloudCoverMax, collection, limit, signal });
  cache.set(key, promise);
  // An aborted/failed search shouldn't poison future identical requests —
  // only cache successes.
  promise.catch(() => cache.delete(key));
  return promise;
}

async function fetchItems({ bbox, dateFrom, dateTo, cloudCoverMax, collection, limit, signal }) {
  const body = {
    collections: [collection],
    bbox,
    datetime: `${dateFrom}T00:00:00Z/${dateTo}T23:59:59Z`,
    limit,
    'query': {
      'eo:cloud_cover': { lte: cloudCoverMax },
    },
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  };

  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new Error(`STAC search failed: ${res.status} ${res.statusText}`);
  }

  const fc = await res.json();
  return fc.features ?? [];
}
