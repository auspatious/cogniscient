/* Reverse geocoding for download file names.
   Uses the free OSM Nominatim API (no key). Failures are non-fatal:
   the caller just omits the place name. Results are cached per lookup
   point so repeated downloads don't re-query. */

const cache = new Map();

// Nominatim's usage policy blocks anonymous non-browser clients, so the CLI
// has to identify itself; browsers can't set User-Agent and don't need to.
const headers = globalThis.window ? undefined : { 'User-Agent': 'cogniscient-cli (https://github.com/auspatious/cogniscient)' };

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
// (state/country/region are deliberately absent: they're the fallback of last
// resort below, not a "local" name that should stop the island search.)
const PLACE_ADDRESS_TYPES = new Set([
  'suburb', 'hamlet', 'village', 'town', 'city', 'municipality', 'county',
  'state_district', 'island', 'neighbourhood', 'borough',
  'city_district', 'peak', 'bay', 'beach', 'nature_reserve',
  'national_park', 'locality',
]);

// Nominatim asks for at most one request per second.
const REQUEST_GAP_MS = 1100;

// Reverse geocoding only sees the single point at the box's centre, which
// over open water or wilderness has nothing local to report — it falls all
// the way back to the state. Search for the most prominent island *inside*
// the box instead (ranked by Nominatim's importance).
// ponytail: islands only — a sea box with no islands still gets the state.
async function islandIn([w, s, e, n]) {
  await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&q=island` +
    `&viewbox=${w},${n},${e},${s}&bounded=1&limit=10&accept-language=en`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
  if (!res.ok) return null;
  const results = await res.json();
  if (!Array.isArray(results) || !results.length) return null;
  // Rank it ourselves: with a small `limit` Nominatim's pick isn't stable.
  return results.reduce((best, r) => ((r.importance ?? 0) > (best.importance ?? 0) ? r : best)).name ?? null;
}

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
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = await res.json();
      const a = j.address || {};
      const ownName = PLACE_ADDRESS_TYPES.has(j.addresstype) ? j.name : null;
      let name =
        ownName || a.hamlet || a.suburb || a.village || a.town || a.city ||
        a.municipality || a.county || a.state_district;
      // Nothing more local than a state, for a box smaller than one (zoom 8+).
      if (!name && zoom >= 8) name = await islandIn([w, s, e, n]);
      name ||= a.state || a.island || a.country;
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
