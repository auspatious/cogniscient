/* Reverse geocoding for download file names.
   Uses the free OSM Nominatim API (no key). Failures are non-fatal:
   the caller just omits the place name. Results are cached per lookup
   point so repeated downloads don't re-query. */

const cache = new Map();

export function slugify(name) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Returns a slugified place name for [lon, lat], or null. */
export async function placeName(lon, lat) {
  const key = `${lon.toFixed(3)},${lat.toFixed(3)}`;
  if (cache.has(key)) return cache.get(key);
  let slug = null;
  try {
    // zoom=16 (Nominatim's "major building"/locality tier) biases the
    // match toward the nearest specific, named place — a peak, island, or
    // locality — instead of always resolving to a city/town. Not every
    // area has one, so `j.name` (the actual matched feature's own name)
    // comes first, and the address hierarchy is only a fallback for when
    // it doesn't — reversed from before, where the broad admin fields
    // were tried first and a specific name was the last resort, which is
    // why remote areas (no nearby city/town) always landed on the state.
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
      `&lat=${lat}&lon=${lon}&zoom=16&accept-language=en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = await res.json();
      const a = j.address || {};
      const name =
        j.name || a.hamlet || a.suburb || a.village || a.town || a.city ||
        a.municipality || a.county || a.state_district || a.state ||
        a.island || a.country;
      if (name) slug = slugify(name) || null;
    }
  } catch {
    /* offline, timeout, or blocked: fine, no place name */
  }
  cache.set(key, slug);
  return slug;
}

/**
 * Forward-geocodes free text to candidate places (for the Search panel's
 * "jump to a place" box). Each result's `bbox` is [west, south, east,
 * north], ready for `map.fitBounds`. Returns [] on any failure — same
 * "silent, caller just gets nothing" contract as placeName.
 */
export async function searchPlaces(query, signal) {
  if (!query.trim()) return [];
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=5`;
    const res = await fetch(url, { signal });
    if (!res.ok) return [];
    const results = await res.json();
    return results.map((r) => ({
      label: r.display_name,
      lon: Number(r.lon),
      lat: Number(r.lat),
      bbox: [Number(r.boundingbox[2]), Number(r.boundingbox[0]), Number(r.boundingbox[3]), Number(r.boundingbox[1])],
    }));
  } catch {
    return [];
  }
}
