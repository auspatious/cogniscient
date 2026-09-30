# Cogniscient

**Live at [cogniscient.auspatious.com](https://cogniscient.auspatious.com/)**

A pure client-side web app (and a CLI) for making pretty pictures from Earth
observation data. Search Sentinel-2 imagery, draw a box on the map, pick an acquisition
day, tune the look, and download a PNG, JPG, or georeferenced TIF. All in
the browser, no backend, no sign-up.

## Using it

1. **Zoom in** to your area of interest. Scene footprints appear as you pan
   and zoom. Adjust the date range and max cloud cover in the Search panel.
2. **Draw a rectangle** over the area you want to export. A size slider sets
   the output resolution, up to the data's native 10 m/px, with an estimate
   of how much data will be fetched.
3. **Pick a day** from the list. Each day shows mean cloud cover, how much of
   your box it covers, and a dropdown of the individual contributing scenes
   — hover one to highlight its footprint, click to open its original STAC
   record. Same-day scenes are merged seamlessly into one image.
4. **Choose a preset** (optional): True colour, False colour (NIR-R-G), and
   six spectral indices — NDVI and NDRE (vegetation), NDBI (built-up), MNDWI
   and NDWI (water), NDMI (vegetation moisture), NBR (burn severity) — or a
   plain Single band. Each sets up the right bands and a sensible Look range
   in one click; the pickers underneath still let you assign any of the 12
   Sentinel-2 bands by hand, to a custom RGB combo, a single band, or a
   custom index `(A − B) / (A + B)`.
5. **Tune the look.** vmin/vmax/gamma sliders re-tone the cached pixels
   instantly, nothing is re-downloaded. For an index or single band, a
   colour map picker (Greens, Reds, Blues, Viridis, and three diverging
   ramps — 8 options including Grayscale) recolours the same stretched
   value, with a Reverse checkbox to flip the ramp's direction.
6. **Download.** PNG/JPG save exactly what you see (stretched, colour-mapped,
   cropped to valid data). TIF instead saves the **raw** reflectance/index
   values — no stretch, no colour map baked in — as a real georeferenced
   GeoTIFF, so it opens correctly positioned in GIS software and stays
   analysis-ready. RGB/single-band TIFs are uint16 (the same type the
   source Sentinel-2 data uses); index TIFs (NDVI etc.) stay float32, since
   their values don't fit an integer type.
7. **Share it.** The URL keeps itself in sync with your box, date range,
   cloud cover, selected day, output size, and visualisation settings —
   copy it and send it, the page it opens will match what you had.

## Command line

The same export pipeline runs headless in Node (Node 20+, after `npm ci`) —
same STAC search, COG windowed reads, mosaic, stretch and GeoTIFF writer as
the web app. Draw nothing; give it a box:

```bash
# True-colour PNG of central Hobart on a given day
npm run cli -- --bbox 147.30,-42.90,147.34,-42.87 --date 2026-09-20 --width 1000

# No --date: see what's available, then export the clearest day automatically
npm run cli -- --bbox 147.30,-42.90,147.34,-42.87 --list-days
npm run cli -- --bbox 147.30,-42.90,147.34,-42.87

# NDVI, colour-mapped, plus STAC provenance JSON
npm run cli -- --bbox 147.30,-42.90,147.34,-42.87 --date 2026-09-20 \
  --mode index --index-bands nir,red --colormap rdylgn --vmin=-0.2 --vmax 0.8 --stac

# Raw, georeferenced GeoTIFF (reflectance DN, or float32 for indices)
npm run cli -- --bbox 147.30,-42.90,147.34,-42.87 --date 2026-09-20 --format tif

# Reproduce a web-app export from its share link (flags override the link)
npm run cli -- --url "https://cogniscient.auspatious.com/?bbox=147.3_-42.9_147.34_-42.87&datetime=2026-09-20"

# Re-run an export from its STAC provenance file (see below)
npm run cli -- --reproduce cogniscient-2026-09-20-rgb-red-green-blue-1000px-west-hobart.png.stac.json
```

`npm link` (or `npm i -g .`) installs it as `cogniscient`. Progress goes to
stderr and the file is written to the current directory, named like the web
app's downloads (`cogniscient-<day>-<bands>-<width>px-<place>.png`) unless you
pass `--out`.

| Flag | Meaning | Default |
|---|---|---|
| `--bbox W,S,E,N` | Box in WGS-84 degrees (required, unless `--url` has one) | |
| `--url URL` | A share link (or bare query string); supplies box, day and look | |
| `--reproduce FILE` | A STAC provenance JSON (from the web app's provenance download, or `--stac`); re-runs that export | |
| `--date YYYY-MM-DD` | Acquisition day to export | clearest day found |
| `--date-from`, `--date-to` | Search window when `--date` is omitted | last 30 days |
| `--cloud-cover-max N` | Max scene cloud cover, % | 80 |
| `--list-days` | Print days found (mean cloud, box coverage, scenes) and exit | |
| `--mode rgb\|single\|index` | What is computed per pixel | `rgb` |
| `--bands R,G,B` | Asset keys for `rgb` | `red,green,blue` |
| `--single-band NAME` | Asset key for `single` | `nir` |
| `--index-bands A,B` | `(A − B) / (A + B)` for `index` | `nir,red` |
| `--vmin`, `--vmax`, `--gamma` | Stretch (PNG only; TIF is unstretched). Negatives need `=`: `--vmin=-0.2` | `0`, `3000`, `1` |
| `--colormap ID` | `single`/`index` only: `gray`, `greens`, `reds`, `blues`, `viridis`, `rdylgn`, `rdbu`, `brbg` | `gray` |
| `--colormap-reversed` | Flip the colour ramp | |
| `--width N` | Output pixel width, capped at native 10 m/px | 1000 |
| `--format png\|jpg\|tif` | `png`/`jpg` are what you'd see in the app; `tif` is raw values | `png` |
| `--out PATH` | Output file | auto-named |
| `--stac` | Also write `<out>.stac.json` provenance (with a link back to the app) | |

`--reproduce` rebuilds the image from the provenance file's box, day,
bands, stretch, format and output width, and fetches the exact source scenes
it lists (`derived_from` links) instead of searching again, so you get the
same pixels even if newer or clearer scenes have since appeared. Flags still
apply on top, e.g. `--reproduce export.stac.json --format tif` for the raw
data behind a PNG. It needs the file's scene links to still resolve, and
the source imagery to still be hosted.

Precedence is defaults, then `--url` / `--reproduce`, then flags. Differences from the web
app: there is no size warning, and with no `--date` the CLI picks the
lowest-cloud day instead of asking you to.

## How it works

Everything runs in the browser. The app is glue code around a handful of
excellent open-source libraries:

| Piece | Library | Used for |
|---|---|---|
| Map | [maplibre-gl](https://maplibre.org/) | Basemap, footprints, box drawing, preview overlay |
| STAC search | plain `fetch` to [Earth Search v1](https://earth-search.aws.element84.com/v1/) | Finding Sentinel-2 scenes and their COG URLs |
| COG reads / TIF write | [geotiff.js](https://geotiffjs.github.io/) | Windowed range-reads of just the bytes covering the drawn box; writes the georeferenced GeoTIFF download |
| Reprojection | [proj4](http://proj4js.org/) | WGS84 box → each scene's native UTM zone |
| Geometry | [@turf/turf](https://turfjs.org/) | Areas, intersections, coverage percentages |
| PNG / JPG encoding | [fast-png](https://github.com/image-js/fast-png), [jpeg-js](https://github.com/jpeg-js/jpeg-js) | Pure-JS encoders, so the browser and the CLI write identical files |
| Date picker | [flatpickr](https://flatpickr.js.org/) | Date-range selection |

The export pipeline: scenes intersecting the box are grouped by solar day;
the drawn box is reprojected to each scene's UTM zone; geotiff.js reads only
the intersecting pixel window of each contributing COG (one band for a
single-band view, two for an index, three for RGB — using internal
overviews, so previews are fast); windows are placed at their true
geographic offsets and merged into one mosaic (brighter pixel wins in
overlaps, which heals resampling artefacts at scene seams); a
vmin/vmax/gamma stretch (plus a colour map for single-band/index) renders
the result to canvas for the on-screen preview and PNG/JPG downloads — the
overlay and the downloaded file are the same pixels, so downloading never
re-fetches. TIF downloads skip that stretch/colour entirely and write the
raw cached values straight to a GeoTIFF, with a WGS-84 tie point and pixel
scale computed from the crop's sub-box, so the file stays numerically
accurate for analysis.

## Local development

Requires Node 20+ (`.nvmrc` provided).

```bash
npm ci        # install dependencies
npm run dev   # dev server at http://127.0.0.1:5173
npm run build # static bundle in dist/
npm run preview
npm test      # unit tests (vitest)
```

Notes:

- The MapTiler basemap key is origin-restricted, so local dev automatically
  falls back to OpenStreetMap tiles. To get the clean basemap locally, add
  your own origins to a MapTiler key in `src/map.js`.
- `dist/` is fully static and can be hosted anywhere. This deployment uses
  Cloudflare Workers static assets: `npx wrangler deploy` (see
  `wrangler.jsonc`).

### Code layout

```
bin/
  cogniscient.js     CLI: the export pipeline below, headless (Node)
src/
  main.js            controller: search, draw, day selection, preview, download
  export.js          COG windowed reads, mosaic compositing, stretch/render
  stac.js            Earth Search POST /search client
  mosaic.js          group scenes by day, cloud/coverage stats
  overviews.js       box size / output pixel geometry helpers
  size-estimate.js   fetch-size estimate and warning tiers
  colormap.js        colour-ramp lookup tables for single-band/index views
  url-state.js       shareable app state <-> URL query string (pure)
  filename.js        export file naming (shared by web app and CLI)
  stac-provenance.js STAC Item describing how an export was made
  geocode.js         Nominatim place names for filenames
  encode.js          PNG/JPG encoding (fast-png + jpeg-js), shared by web app and CLI
  map.js             MapLibre setup and basemap
  footprint-layer.js scene footprint + selection layers
  rectangle-draw.js  click-drag box drawing
  state.js           tiny reactive store
  ui/                one small render function per sidebar panel
```

Contributions welcome. Keep it simple, keep it client-side.

## Credits

- Built by [Auspatious](https://auspatious.com/).
- Imagery search and cloud-optimised GeoTIFFs served by
  [Earth Search](https://earth-search.aws.element84.com/v1/), a free STAC API
  operated by [Element 84](https://element84.com/). Thank you!
- Contains modified [Copernicus](https://www.copernicus.eu/) Sentinel-2 data,
  hosted in the [AWS Open Data](https://registry.opendata.aws/sentinel-2-l2a-cogs/)
  program.
- Inspired by the
  [DEA image export notebook](https://github.com/GeoscienceAustralia/dea-notebooks/blob/rbt/Interactive_apps/Exporting_satellite_images.ipynb)
  from Geoscience Australia.
- Basemaps by [MapTiler](https://www.maptiler.com/) and
  [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.

## License

[Apache 2.0](LICENSE)
