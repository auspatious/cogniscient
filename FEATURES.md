# Cogniscient required features

This file is the source of truth for what the app must do. Changes to
behaviour should update this file in the same commit. No drift!

## Core workflow

1. **Search**: query the Earth Search STAC API
   (https://earth-search.aws.element84.com/v1, collection sentinel-2-l2a)
   for the current map view, with a date range (default: last 30 days) and
   a max cloud cover filter (default: 100%, i.e. no filtering). Searching
   requires a minimum zoom level (4 — roughly continent-scale) to avoid
   huge result sets; the search's own `limit` (100) caps response size
   further at any zoom.
   - `searchItems()` (`src/stac.js`) caches by an exact
     `{bbox, dateFrom, dateTo, cloudCoverMax, collection}` key (the promise
     itself, not just its result, so concurrent identical calls collapse
     into one fetch) — panning back over an already-searched extent,
     toggling the basemap, or an undo-ish back-and-forth doesn't refire the
     query. Deliberately exact-match only, no fuzzy/tile-snapped bbox
     rounding or partial-coverage merging — `moveend` bboxes are
     essentially never bit-identical across two different pans, so this
     only (and only needs to) catch genuine repeat views. No TTL/eviction.
   - **Jump to a place**: a debounced (300ms) autocomplete box above the
     date range, forward-geocoding via Nominatim's `/search` endpoint
     (`searchPlaces()` in `geocode.js` — same silent-failure contract as
     the existing reverse-geocode used for download filenames). Up/down
     cycles results, enter or click picks one and `fitBounds`es the map to
     it; the map's existing `moveend` handler re-triggers the STAC search.
     Results float over the rest of the panel rather than pushing it down.
2. **Draw a box**: the user draws a rectangle on the map to define the
   export area. A stray click (zero-size box) cancels instead of drawing.
3. **Pick a day**: results are grouped by acquisition day (`groupByDay` in
   `mosaic.js`), sorted newest-first. A day only appears once a box is
   drawn if at least one of its scenes intersects the box, but each day
   shows *every* scene the search found for it — not just the intersecting
   ones — so you can see what else was captured nearby:
   - The most recent day is selected automatically the moment there's a
     list to pick from — no click needed. This only fires when nothing is
     already selected (a fresh search, or a box redrawn such that the
     previous selection no longer applies); it never overrides an existing
     selection, including one a background search update alone made
     temporarily vanish from the list (see the note on that below).
   - mean cloud cover (%) and coverage (%, how much of the drawn box the
     union of footprints covers) are both computed from the intersecting
     scenes only (`renderItems`) — the ones actually used for the mosaic.
   - a dropdown toggle showing the total scene count (all of them);
     expanding it lists every contributing STAC item (id + its own cloud
     cover %), dimmed for ones outside the drawn box, preserving list
     scroll position across the toggle. Hovering an item row highlights
     just that item's footprint on the map (white outline, drawn above the
     selected-day highlight); clicking opens the item's canonical STAC JSON
     (its `self` link) in a new tab.
   - On the map, the selected day's footprints are all shown too, coloured
     by whether they intersect the box: gold (bold outline) for ones used
     in the mosaic, blue (thin outline, matching the regular all-items
     colour) for ones found nearby but not used.
   - Panning keeps searching in the background (the `moveend` handler) so
     the day list stays current, but once a day's preview has rendered,
     panning never redraws — or clears — it out from under the user, even
     if the search (viewport-scoped) no longer returns anything for the
     drawn box at all, e.g. after panning away from it. The selection and
     cache are only ever touched by a deliberate action: picking a
     different day, redrawing the box, resizing, or changing the look —
     never a bare search-result update. If the selected day still has
     scenes but a different set than what's rendered (e.g. panning revealed
     a new one), its row gets a "Redraw" button (only while nothing's
     already loading) instead of auto-redrawing; clicking it re-fetches
     with whatever scenes are currently available. If it has none at all,
     its row just doesn't appear in the list until a fresh box/search
     brings it back — the rendered image is unaffected either way.
4. **Preview**: a mosaicked RGB preview streams from the COGs and is shown
   as an image overlay on the map, georeferenced inside the drawn box.
   - **Live scene preview** (`src/live-preview.js`, `initLivePreview()`): a
     second, independent preview — every individual scene for the selected
     day (not a merged composite, and not scoped to a drawn box), rendered
     live via `deck.gl-raster`'s `COGLayer` (GPU adaptive-mesh reprojection)
     on top of the map through `@deck.gl/mapbox`'s `MapboxOverlay`, in
     **interleaved** mode — real `beforeId` z-ordering, so it renders below
     footprints/the drawn box/the fade mask (`main.js`'s
     `reassertLayerOrder()`/`lowestOverlayLayerId()`). Interleaved mode
     originally hit a real MapLibre v6 incompatibility (its render-sync
     path unconditionally read a non-public `map.transform` property
     MapLibre v6 no longer exposes directly, having moved to an internal
     `_camera` composition) — confirmed against `@deck.gl/mapbox`'s own
     source and against deck.gl-raster's own `examples/land-cover` (pinned
     to maplibre-gl v5, where interleaved mode works). Resolved by
     downgrading `maplibre-gl` to `5.24.0` (see the `maplibre-gl` entry in
     the Map section) rather than staying on overlaid mode's z-order
     limitation.
     - Always true-color RGB — each scene renders via its own
       pre-stretched 8-bit `visual` COG asset, ignoring `state.viz`/
       `vizMode` entirely, by design. A GPU-side pass-through of the full
       Visualise styling (bands/stretch/gamma/colormap/index, via
       deck.gl-raster's per-mode `MultiCOGLayer` + custom shader modules)
       was built and reverted — real scenes rendered as flat grey tiles
       rather than imagery (root cause not fully isolated: likely
       `MultiCOGLayer`'s multi-band-source compositing, since the same
       custom modules weren't yet in play for the failing `rgb`-mode
       case). Not worth the added complexity for this app right now; the
       full Visualise styling applies only to the drawn region's own
       CPU-composited preview (`export.js`) — this live preview stays a
       simple "what's available to browse" view.
     - Reacts to `state.selectedDay`/`itemsByDay` changing.
     - Fully independent of the CPU pipeline below: this is browsing, not
       a source of truth for anything downloaded.
     - Two dev-only Vite fixes this required, both in `vite.config.js`:
       `optimizeDeps.esbuildOptions.target: 'es2022'` (a transitive dep,
       `@developmentseed/lzw-tiff-decoder`, uses top-level `await`, which
       the dev-server's dependency pre-bundler doesn't support at its
       default target even though the production `build.target` already
       was `es2022`), and adding `@developmentseed/geotiff` to
       `optimizeDeps.exclude` (its COG decoder-pool Worker, constructed via
       `new Worker(new URL('./worker.js', import.meta.url))`, can't survive
       Vite's dev-time dependency rewriting).
5. **Visualise** (one panel, combining band/index selection and look-tuning
   — they're one "how the pixels are computed and shown" concern):
   - A small "Reset" button beside the Preset label goes straight back to
     True colour RGB with every visualise field (bands, vmin/vmax/gamma,
     colour map, reversed) at its `DEFAULT_STATE` value (`state.js`) — a
     full reset, unlike picking a preset, which only resets the Look
     sliders/colour map sensible for that mode and leaves anything else
     (e.g. a hand-edited band) alone.
   - A preset dropdown picks the visualisation mode and its band mapping in
     one step: True colour RGB, False colour NIR-R-G, NDVI, NDBI, MNDWI,
     NDWI, NDMI, NDRE, NBR, or Single band. Per-mode pickers underneath
     allow full customisation (three band selects for RGB, one for single
     band, two — "A"/"B" — for a custom index). Hand-editing a picker
     switches the preset label to "Custom" without changing mode. Changing
     bands, or the mode itself, refetches. Picking a preset also resets the
     Look sliders (and colour map) to defaults sensible for that mode;
     hand-edited bands do not.
     - `vizMode` is one of:
       - `rgb` — three bands composited straight into R/G/B (default: true
         colour red/green/blue).
       - `single` — one band, shown as grayscale (r = g = b = band value).
       - `index` — normalized difference of two bands, `(a - b) / (a + b)`,
         shown as grayscale. A pixel needs real data in *both* source bands
         to count as valid — an index value of exactly 0 is a real
         measurement, not nodata, so it isn't dropped like an all-zero RGB
         pixel would be. Index presets and their band pairs:
         - NDVI (vegetation) = (nir-red)/(nir+red)
         - NDBI (built-up) = (swir16-nir)/(swir16+nir)
         - MNDWI (water) = (green-swir16)/(green+swir16)
         - NDWI (water, McFeeters) = (green-nir)/(green+nir)
         - NDMI (vegetation moisture) = (nir-swir16)/(nir+swir16)
         - NDRE (red edge / chlorophyll) = (nir-rededge1)/(nir+rededge1)
         - NBR (burn severity) = (nir-swir22)/(nir+swir22)
   - Below the band pickers: vmin / vmax / gamma sliders, never
     auto-overridden by fetches — only a preset change resets them.
     Range/step adapts to `vizMode`: 0–15000 (step 50) for `rgb`/`single`
     reflectance DN, -1–1 (step 0.01) for `index`. For `single`/`index`
     only, a colour-map picker sits directly below the band pickers (8
     options: Grayscale, Greens, Reds, Blues, Viridis, and three diverging
     ramps — Red-Yellow-Green, Red-Blue, Brown-Teal) and recolours the same
     stretched value, with a "Reverse" checkbox beside its label that flips
     which end of the stretch maps to which end of the ramp (works for
     Grayscale too, since that's the same code path with no LUT applied);
     `rgb` mode has no colour map (it already has 3 real bands) and ignores
     `viz.colormap`/`viz.colormapReversed` even if set. Repaints reuse the
     cached pixel data; no refetch.
6. **Download**: export the preview as PNG, JPG, or TIF from cached data (no
   refetch), named
   `cogniscient-<day>-<bands>-<width>px-<place>.<ext>` where `<bands>`
   describes what's actually in the image — `rgb-<r>-<g>-<b>`,
   `single-<band>`, or `index-<a>-<b>` — and `<place>` is a
   reverse-geocoded name (OSM Nominatim, city/region level) for the
   centre of the drawn box. Geocoding failures are silent: the name is
   simply omitted.
   - PNG/JPG save the stretched/colour-mapped *display* pixels, cropped to
     valid data. No georeferencing.
   - TIF saves the **raw** reflectance DN (`rgb`/`single`) or index values
     (`index`) — vmin/vmax/gamma/colormap are display-only and never baked
     into it — as a georeferenced GeoTIFF (WGS-84 tie point + pixel scale
     computed from the crop's sub-bbox, via geotiff.js's `writeArrayBuffer`),
     3-band for `rgb`, 1-band for `single`/`index`.
     - `rgb`/`single` are written as **uint16**, the same sample type the
       source Sentinel-2 COGs use. Masked-out pixels are `0` (reusing raw
       DN's own nodata convention) with a `GDAL_NODATA: '0'` tag. Values are
       rounded and clamped into `[0, 65535]` before writing, since a
       `Uint16Array` assignment truncates and wraps rather than doing
       either of those.
     - `index` stays **float32** — its values (e.g. NDVI's -1..1) can't be
       represented as uint16 — with masked-out pixels as `NaN` and a
       `GDAL_NODATA: 'nan'` tag, since reusing `0` there would be wrong (an
       index value of exactly 0 is real data).
     - It is **not** a tiled/overview Cloud-Optimized GeoTIFF — geotiff.js's
       writer has no tiling/overview support, only flat single-strip TIFFs;
       see the open question in the PR/commit that introduced this if that
       changes.
   - **Metadata**: a second button next to Download saves a minimal STAC
     Item (`src/stac-provenance.js`, `buildStacProvenance()`) describing how
     the export was produced — source-scene lineage (`derived_from` links
     to each scene's own `self` link, plus `processing:lineage`), the
     drawn box as `bbox`/`geometry`, the selected day as `datetime`, and
     the band/index selection + stretch settings actually in effect (the
     colour map is omitted for `rgb` mode, since it has no effect there).
     Links include the webapp (`rel: about`) and a URL that reproduces the
     exact same export (`rel: alternate`, built from `buildParams` — the
     same shareable-URL machinery as the Share panel). Its one asset uses
     the STAC-spec role `data` (GeoTIFF) or `visual` (PNG/JPG) depending on
     the current format, and shares the exact same base filename as the
     real export (only the extension differs — `.stac-item.json`), via a
     `buildExportBlob()`/`exportBaseFilename()` path both download
     functions call so they can never drift apart.

## Data handling rules

- **Multi-COG same-day mosaic**: all scenes from the selected day that
  intersect the box are merged. On overlap, keep the brighter pixel
  (larger r+g+b) to heal resampled nodata seams at scene edges.
  - Each item is placed into the output canvas by a true **per-pixel
    warp** (`warpItemInto()` in `export.js`, matching how odc-loader's RIO
    driver ultimately calls `rasterio.warp.reproject()`): for every
    candidate destination pixel, reproject its centre into the item's UTM
    CRS and bilinearly sample the item's own pixel grid there. Each item
    is read once per band into a dense grid (`readSourceGrid()` — a plain
    windowed read, no placement) at roughly the output's pixel density
    (using overviews); the warp step is what maps it onto the shared
    WGS-84 canvas, regardless of what UTM zone it's in.
  - This *isn't* optional precision — placing by a single affine derived
    from a window's corner points (whether corners in the item's own CRS,
    or corners un-projected back to WGS-84) only holds up within one UTM
    zone, because it assumes the CRS-to-CRS transform is uniform
    (translate + scale, no rotation/shear) across the whole window. Real
    UTM-to-UTM transforms have grid convergence that varies continuously
    with position, so a large enough window straddling a zone boundary
    visibly seams and shears under any corner-derived affine. Per-pixel
    reprojection is the only approach that stays correct there.
- **Use overviews**: read at a reasonable output resolution (target width
  default 1000 px, user adjustable), never full native resolution of a
  large area by default. The Area panel's output-size slider always reaches
  exactly the box's native pixel width (10 m/px) at its top end — its
  min/max/step are computed by `sliderRange()` (`overviews.js`), which
  shifts the slider's `min` up (by less than one step) rather than
  rounding native max down to the nearest step, since a range input can
  only be dragged all the way to `max` if `(max - min)` is an exact
  multiple of `step`. When native resolution doesn't clear the slider's
  floor by at least one step, there's genuinely only one achievable size
  (native itself), so `sliderRange()` returns `collapsed: true` and the
  Area panel renders the slider disabled and pinned to the right (100%)
  rather than at an arbitrary/left-biased position.
- **Range reads only**: compute pixel windows from the COG geotransform;
  never fetch whole files.
- **Size warning**: before fetching, show an estimated download size
  ("fetches ~X MB" - raw fetch traffic, not output file size) with a
  soft-warning tier, and a hard limit of 10,000 km² for the drawn box.
- **Cache keying**: the scene cache key includes day, bbox, target width,
  vizMode, the active bands for that mode, and the contributing item IDs, so
  any change that alters the mosaic (including cloud-filter changes)
  triggers a refetch.
- If the selected day disappears from new search results, clear the
  selection and preview.

## Map

- MapLibre GL JS **v5** (`5.24.0` — deliberately not v6; see the live scene
  preview note above) with two MapTiler basemaps (`BASEMAPS` in `map.js`) — the
  dark dataviz style (default, button reads "MAP") and satellite imagery
  (button reads "SAT") — toggled via a compact button next to the zoom
  controls (`createToggleControl()`, a small reusable button showing
  *current* state). Also used for the STAC-footprints visibility toggle
  ("ON"/"OFF", top-right, same row) — hides/shows the footprint layers via
  a `visibility` layout-property flip on all of `FOOTPRINT_LAYER_IDS`
  (`footprint-layer.js`), reapplied on every `'style.load'` since a style
  swap creates fresh layer instances. Falls back to OSM raster on style
  error (e.g. local dev where the MapTiler key is rejected).
  - `map.setStyle()` wipes any source/layer not defined in the new style's
    own JSON — i.e. everything this app adds itself (footprints, drawn
    box, fade mask, preview overlay). These re-add themselves on
    `'style.load'` (fires on every style change, unlike `'load'`, which
    fires once ever) so switching basemap never loses the current
    box/preview.
- Preview show/hide lives in the **Area** panel instead (a small button
  above the draw-rectangle controls, labelled "Hide preview"/"Show
  preview" with a tooltip explaining what it does) — shows/hides the
  preview overlay without discarding the cached fetch, a `visibility`
  layout-property flip, not a re-render or re-fetch. Local UI state only,
  not part of the URL.
- Default view: whole world (center [0, 20], zoom 1).
- STAC footprints always drawn (logo blue #3474c7); when a box is drawn
  and a day is selected, only that day's footprints show, highlighted in
  gold (#fbc27b). Drawn box is white.
- The maplibre worker must be bundled self-contained
  (`?worker&url` import + `setWorkerUrl`) or GeoJSON layers silently
  break in production.
- Camera position (zoom/lat/lng) lives in the URL **hash** via MapLibre's
  own `hash: true` — not something this app's code manages.

## Shareable URL

- Everything else shareable lives in the URL's **query string** (kept
  independent of the hash above), read/written via pure functions in
  `url-state.js` (`parseParams`/`buildParams` — no `location`/`history`
  access there, so they're plain to unit test; `main.js` supplies the
  actual browser globals):
  - Only fields that deviate from `DEFAULT_STATE` (`state.js`) are
    written, and every value sticks to characters
    (`A-Za-z0-9 - . _`) that `application/x-www-form-urlencoded` never
    percent-encodes — so a shared URL of default-ish settings stays short
    and stays plain text instead of turning into `%`-escaped noise.
  - `bbox` — drawn box, `west_south_east_north` (underscore-joined, 5
    decimal places ≈ 1m; comma isn't used since it gets percent-encoded).
    Always written when a box is drawn (no meaningful "default" bbox).
  - The date **range** itself (`dateFrom`/`dateTo`) is never written —
    only `datetime`, a single-value date (the selected day), is, always,
    whenever a day is selected. On restore, `main.js` searches a
    single-day window around it instead of the rolling "last 30 days"
    default — otherwise a link shared weeks or months ago could silently
    stop finding the item it was shared for.
    `parseParams` tells the two shapes `datetime` can carry apart by
    whether it contains a `/`: a single value (no `/`) is the selected day
    (the current, only, format `buildParams` writes); a `<dateFrom>/<dateTo>`
    range is the legacy date-range format from before this param was
    repurposed, and doesn't set a selected day on its own — a legacy
    `selected_datetime` param alongside it (older links always paired the
    two) still does, and is honored for backward compat even though
    `buildParams` no longer writes it either.
  - `cloud_cover_max`, `width` (target output width), `basemap` (which
    `BASEMAPS` entry) — written only on deviation from default.
  - Visualise settings, one flat param per field, written only on
    deviation: `preset`, `viz_mode`, `bands` (dash-joined `r-g-b`),
    `single_band`, `index_bands` (dash-joined `a-b`), `vmin`, `vmax`,
    `gamma`, `format`, `colormap`, `colormap_reversed` (`0`/`1`).
    Replaces the old single `visualise_settings` JSON blob — `parseParams`
    still reads that legacy shape too (only when none of the flat params
    above are present) so links shared before this change keep working.
- Restored on load (a `bbox` also redraws the box outline via
  `draw.setBbox()`, reusing the exact same `onDrawnBbox` path a real
  drag/click takes — no separate restore logic to keep in sync; `basemap`
  is applied before the map is even constructed, since it's needed for
  the initial style). Written back on every relevant state change,
  debounced 400ms so continuous interactions (slider drags) don't spam
  the address bar; uses `history.replaceState`, never `pushState`, so it
  doesn't pollute the back button.
- Not included: the collection (`sentinel-2-l2a` — hardcoded, no UI to
  change it), camera position (already in the hash, see above), and the
  preview-visibility toggle (ephemeral display state, not shareable).

## UI

- Sidebar panels in order: Search, Area, Days, Visualise, Export, Status.
  No sidebar preview image (map overlay only). Visualise combines band/index
  selection and the Look sliders in one panel (preset dropdown, band
  pickers, colour map, then vmin/vmax/gamma) since they're one coherent
  "how the pixels are computed and shown" concern.
- Panels use a paint-key render guard so progress updates never rebuild
  DOM mid-interaction (sliders, dropdowns). Fetch progress renders inside
  the loading day's own row in the Days list (a thin bar under that day's
  subtitle), not as a separate block above the list — that used to bump
  every row up/down each time a fetch started or finished.
- Auspatious brand theme: Space Grotesk headings (uppercase, wide
  tracking), Inclusive Sans body, ausblue #194bfd accent, gold #fbc27b
  secondary, #232323 dark panels, rounded corners, Auspatious favicon.
- Header: app name "Cogniscient", tagline, "Built with ❤️ by Auspatious"
  link, and a link to GitHub issues.

## Architecture and deployment

- 100% client-side, no backend. Vite build, plain JS, small modules:
  store (state.js) + controller (main.js) + panels (src/ui/).
- Unit tests (vitest, `npm test`) cover the pure logic modules: mosaic
  grouping/coverage, output-size geometry, size estimates, geocode slugify,
  UTM reprojection, mosaic merge/crop math, the NDVI/NDBI-style normalized-
  difference calculation, and a real read-back round trip of the GeoTIFF
  writer. GitHub Actions runs tests + build on every push/PR.
- Unexpected runtime errors (uncaught exceptions, unhandled promise
  rejections) are surfaced in the Status panel via `log.err`, not just the
  console.
- Deployed as Cloudflare Workers static assets (worker name
  `image-exporter`, do not rename - the cogniscient.auspatious.com route
  depends on it). Deploy: `npm run build && npx wrangler deploy`.
- Live at https://cogniscient.auspatious.com/.
- Apache 2.0 licensed; credits to Auspatious, Element 84 / Earth Search,
  Copernicus Sentinel-2 on AWS Open Data, DEA notebook, MapTiler / OSM.
