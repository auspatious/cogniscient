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

// Nominatim's reverse-geocode "zoom" picks which layer of feature it
// matches (10 = city, 14 = suburb, 18 = building) — map the drawn export
// box's extent onto that scale so a city-wide export names the city and a
// small, zoomed-in box names the local feature (a beach, a peak) instead.
function zoomForExtent(extentDeg) {
  if (extentDeg >= 2) return 6; // state/region
  if (extentDeg >= 0.5) return 8; // county
  if (extentDeg >= 0.15) return 10; // city
  if (extentDeg >= 0.05) return 12; // town
  if (extentDeg >= 0.02) return 14; // suburb/neighbourhood
  if (extentDeg >= 0.005) return 16; // locality
  return 18; // building/beach scale
}

// At high zoom Nominatim often matches the nearest road, path, building, or
// parking lot rather than a real place — its `addresstype` says what kind
// of feature it actually matched. Only trust the matched feature's own
// name (`j.name`) when that type is a genuine place, so a beach-scale
// export doesn't get named after e.g. "Overland Track" or "Campbell
// Parade"; anything else falls through to the address hierarchy.
const PLACE_ADDRESS_TYPES = new Set([
  'suburb', 'hamlet', 'village', 'town', 'city', 'municipality', 'county',
  'state_district', 'state', 'island', 'country', 'neighbourhood', 'borough',
  'city_district', 'region', 'peak', 'bay', 'beach', 'nature_reserve',
  'national_park', 'locality',
]);

/** Returns a slugified place name for the drawn export bbox [w, s, e, n], or null. */
export async function placeName([w, s, e, n]) {
  const lon = (w + e) / 2;
  const lat = (s + n) / 2;
  const zoom = zoomForExtent(Math.max(e - w, n - s));
  const key = `${lon.toFixed(3)},${lat.toFixed(3)},${zoom}`;
  if (cache.has(key)) return cache.get(key);
  let slug = null;
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
      `&lat=${lat}&lon=${lon}&zoom=${zoom}&accept-language=en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = await res.json();
      const a = j.address || {};
      const ownName = PLACE_ADDRESS_TYPES.has(j.addresstype) ? j.name : null;
      const name =
        ownName || a.hamlet || a.suburb || a.village || a.town || a.city ||
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
