import { fromUrl, Pool, writeArrayBuffer } from 'geotiff';
import proj4 from 'proj4';
import { bboxPolygon } from '@turf/bbox-polygon';
import { booleanIntersects } from '@turf/boolean-intersects';
import { colormapLUT } from './colormap.js';
import { encodeImage, MIME } from './encode.js';

const pool = new Pool();

// Handle cache. Same COG re-opened many times → we open it once. Capped and
// LRU-evicted so a long session panning across many regions doesn't hold
// open handles for every COG it has ever touched.
const MAX_CACHED_ASSETS = 64;
const imageCache = new Map();
async function openAsset(href) {
  if (imageCache.has(href)) {
    const entry = imageCache.get(href);
    imageCache.delete(href); // re-insert to mark as most recently used
    imageCache.set(href, entry);
    return entry;
  }
  const entry = fromUrl(href, { cacheSize: 32 });
  imageCache.set(href, entry);
  if (imageCache.size > MAX_CACHED_ASSETS) {
    imageCache.delete(imageCache.keys().next().value);
  }
  return entry;
}

/* ── Coordinate transforms ────────────────────────────────────────────── */

export function utmProj(epsg) {
  const code = String(epsg);
  if (!code.startsWith('326') && !code.startsWith('327')) {
    throw new Error(`Unsupported CRS EPSG:${epsg} (only WGS84 UTM north/south)`);
  }
  const zone = parseInt(code.slice(3), 10);
  const south = code.startsWith('327');
  return `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
}

// warpItemInto calls this per destination pixel (hundreds of thousands of
// times per item) — caching avoids re-parsing the proj string and
// reconstructing the whole conversion pipeline on every single pixel.
const projConverterCache = new Map();
function projConverter(epsg) {
  let p = projConverterCache.get(epsg);
  if (!p) {
    proj4.defs(`EPSG:${epsg}`, utmProj(epsg));
    p = proj4('EPSG:4326', `EPSG:${epsg}`);
    projConverterCache.set(epsg, p);
  }
  return p;
}

export function reprojectBbox(bbox4326, epsg) {
  const p = projConverter(epsg);
  const [w, s, e, n] = bbox4326;
  const c = [p.forward([w, s]), p.forward([e, s]), p.forward([e, n]), p.forward([w, n])];
  const xs = c.map((x) => x[0]);
  const ys = c.map((x) => x[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** WGS-84 [lon, lat] → item CRS [x, y]. */
export function projectPoint(lon, lat, epsg) {
  return projConverter(epsg).forward([lon, lat]);
}

/** Inverse of projectPoint: item CRS [x, y] → WGS-84 [lon, lat]. */
export function unprojectPoint(x, y, epsg) {
  return projConverter(epsg).inverse([x, y]);
}

/* ── Windowed COG read ────────────────────────────────────────────────── */

/**
 * Reads the part of a COG that overlaps the drawn box as a small dense
 * grid — pixels plus the origin/resolution needed to sample it — at
 * roughly the output's pixel density, so overviews still get used for
 * large boxes. Does *not* place the pixels in the output canvas: that
 * needs a true per-pixel reprojection (see warpItemInto). A single affine
 * derived from this window's corners only holds up within one UTM zone —
 * for items straddling a zone boundary it visibly seams and shears, since
 * the rotation/shear between zones isn't uniform across a large window.
 *
 * Returns `null` when the item doesn't intersect the drawn box.
 */
async function readSourceGrid(href, bbox4326, outWidth, outHeight, itemEpsg, signal) {
  const tiff = await openAsset(href);
  const image = await tiff.getImage(0);
  const epsg = image.geoKeys?.ProjectedCSTypeGeoKey ?? itemEpsg;
  const dbn = reprojectBbox(bbox4326, epsg); // drawn box in item's CRS — fine for finding the relevant *source* pixels; the cross-zone bug was in using this to *place* output pixels, not in using it to find source ones.
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution(); // ry negative on north-up rasters
  const W = image.getWidth();
  const H = image.getHeight();

  // Image bbox in native CRS.
  const imgX0 = ox;
  const imgX1 = ox + W * rx;
  const imgY1 = oy;
  const imgY0 = oy + H * ry;

  // Intersection of drawn box and image bbox.
  const iX0 = Math.max(dbn[0], imgX0);
  const iX1 = Math.min(dbn[2], imgX1);
  const iY0 = Math.max(dbn[1], imgY0);
  const iY1 = Math.min(dbn[3], imgY1);
  if (iX1 <= iX0 || iY1 <= iY0) return null;

  // Pixel window on the image.
  const px0 = Math.max(0, Math.floor((iX0 - ox) / rx));
  const px1 = Math.min(W, Math.ceil((iX1 - ox) / rx));
  const py0 = Math.max(0, Math.floor((oy - iY1) / -ry));
  const py1 = Math.min(H, Math.ceil((oy - iY0) / -ry));
  const nativeW = px1 - px0;
  const nativeH = py1 - py0;
  if (nativeW <= 0 || nativeH <= 0) return null;

  // Rough read size — purely a performance choice (lets geotiff.js pick a
  // suitable overview level); not the final geometry. warpItemInto samples
  // this grid at exact reprojected coordinates regardless of its
  // resolution, so downsampling it here doesn't reintroduce the bug.
  const boxW = dbn[2] - dbn[0];
  const boxH = dbn[3] - dbn[1];
  const readW = Math.max(1, Math.min(nativeW, Math.round(((iX1 - iX0) / boxW) * outWidth)));
  const readH = Math.max(1, Math.min(nativeH, Math.round(((iY1 - iY0) / boxH) * outHeight)));

  const data = await image.readRasters({
    window: [px0, py0, px1, py1],
    width: readW,
    height: readH,
    samples: [0],
    resampleMethod: 'bilinear',
    pool,
    fillValue: 0,
    signal,
  });

  return {
    pixels: data[0],
    width: readW,
    height: readH,
    // Origin/resolution of the grid as actually read (may be downsampled
    // from native), so callers can map any item-CRS point to a pixel here.
    originX: ox + px0 * rx,
    originY: oy + py0 * ry,
    resX: (nativeW * rx) / readW,
    resY: (nativeH * ry) / readH,
    epsg,
  };
}

/* ── Per-pixel warp: reprojected sampling into the output mosaic ──────── */

/** Bilinearly samples a source grid at fractional pixel coords; `null` outside its bounds. */
export function bilinearSample(grid, fx, fy) {
  const { pixels, width, height } = grid;
  if (fx < 0 || fy < 0 || fx > width - 1 || fy > height - 1) return null;
  const x0 = Math.min(Math.max(width - 2, 0), Math.floor(fx));
  const y0 = Math.min(Math.max(height - 2, 0), Math.floor(fy));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = pixels[y0 * width + x0];
  const v10 = pixels[y0 * width + x1];
  const v01 = pixels[y1 * width + x0];
  const v11 = pixels[y1 * width + x1];
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

/**
 * The destination pixel range (in the output canvas) a source grid could
 * possibly cover, by un-projecting its own corners back to WGS-84.
 * Deliberately generous by a pixel: anything outside the grid's *true*
 * coverage is simply skipped later by bilinearSample's bounds check, so
 * over-estimating this range costs a little wasted work, never correctness.
 */
function destRangeFor(grid, bbox4326, outWidth, outHeight) {
  const { originX, originY, resX, resY, width, height, epsg } = grid;
  const corners = [
    [originX, originY], [originX + width * resX, originY],
    [originX, originY + height * resY], [originX + width * resX, originY + height * resY],
  ].map(([x, y]) => unprojectPoint(x, y, epsg));
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  const [w4326, s4326, e4326, n4326] = bbox4326;
  const boxWdeg = e4326 - w4326;
  const boxHdeg = n4326 - s4326;
  return {
    i0: Math.max(0, Math.floor(((Math.min(...lons) - w4326) / boxWdeg) * outWidth) - 1),
    i1: Math.min(outWidth, Math.ceil(((Math.max(...lons) - w4326) / boxWdeg) * outWidth) + 1),
    j0: Math.max(0, Math.floor(((n4326 - Math.max(...lats)) / boxHdeg) * outHeight) - 1),
    j1: Math.min(outHeight, Math.ceil(((n4326 - Math.min(...lats)) / boxHdeg) * outHeight) + 1),
  };
}

/**
 * Warps one item's already-read grid(s) into the shared output mosaic: for
 * every candidate destination pixel, reproject its centre into the item's
 * CRS and bilinearly sample each grid there. This is what a real warp
 * (e.g. GDAL's `reproject()`, which odc-loader uses under the hood) does —
 * true per-pixel sampling — rather than pasting a block placed by a single
 * affine derived from a couple of corner points, which only holds up
 * within one UTM zone.
 *
 * `toPixel(rawSamples)` turns the grids' raw sampled values into
 * `{ r, g, b, valid }` for this destination pixel (or a falsy value to
 * skip it) — mode-specific (rgb/single/index). Where items overlap, the
 * brighter pixel wins: bilinear resampling blends nodata (0) into
 * scene-edge pixels, darkening them, so preferring brightness heals the
 * seam with the neighbouring scene's clean data.
 */
export function warpItemInto(arrays, grids, bbox4326, toPixel) {
  const { width: outWidth, height: outHeight, r, g, b, mask } = arrays;
  const { i0, i1, j0, j1 } = destRangeFor(grids[0], bbox4326, outWidth, outHeight);
  const [w4326, s4326, e4326, n4326] = bbox4326;
  const boxWdeg = e4326 - w4326;
  const boxHdeg = n4326 - s4326;
  const epsg = grids[0].epsg;

  for (let j = j0; j < j1; j++) {
    const lat = n4326 - ((j + 0.5) / outHeight) * boxHdeg;
    const outRowBase = j * outWidth;
    for (let i = i0; i < i1; i++) {
      const lon = w4326 + ((i + 0.5) / outWidth) * boxWdeg;
      const [x, y] = projectPoint(lon, lat, epsg);
      const raw = grids.map((grid) => bilinearSample(grid, (x - grid.originX) / grid.resX, (y - grid.originY) / grid.resY));
      if (raw.some((v) => v === null)) continue;
      const px = toPixel(raw);
      if (!px || !px.valid) continue;
      const outIdx = outRowBase + i;
      if (mask[outIdx] && r[outIdx] + g[outIdx] + b[outIdx] >= px.r + px.g + px.b) continue;
      r[outIdx] = px.r; g[outIdx] = px.g; b[outIdx] = px.b; mask[outIdx] = 1;
    }
  }
}

/* ── Per-item read + warp, by visualisation mode ──────────────────────── */

/**
 * (a - b) / (a + b) for one pixel. Both raw inputs must be non-zero —
 * unlike reflectance DN, a computed index can legitimately be exactly 0,
 * so the "all channels zero = nodata" heuristic doesn't apply here.
 */
function normalizedDifferenceScalar(va, vb) {
  if (va === 0 || vb === 0) return null;
  const denom = va + vb;
  return denom === 0 ? 0 : (va - vb) / denom;
}

/** Array-wise version of the same formula (used by tests and, in future, batch callers). */
export function normalizedDifference(pixelsA, pixelsB) {
  const n = pixelsA.length;
  const value = new Float32Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = normalizedDifferenceScalar(pixelsA[i], pixelsB[i]);
    if (v === null) continue;
    value[i] = v;
    valid[i] = 1;
  }
  return { value, valid };
}

/**
 * Reads the bands one item contributes for the given mode and warps them
 * into the shared output mosaic (a no-op if the item doesn't intersect the
 * drawn box). `bands` shape depends on `mode`: `{ r, g, b }` for 'rgb'
 * (default), `{ band }` for 'single', `{ a, b }` for 'index'
 * (value = (a - b) / (a + b)).
 */
async function warpItem(arrays, item, mode, bands, drawnBbox, epsg, signal) {
  if (mode === 'single') {
    const grid = await readSourceGrid(item.assets[bands.band].href, drawnBbox, arrays.width, arrays.height, epsg, signal);
    if (!grid) return;
    warpItemInto(arrays, [grid], drawnBbox, ([v]) => (v === 0 ? null : { r: v, g: v, b: v, valid: true }));
    return;
  }

  if (mode === 'index') {
    const [gridA, gridB] = await Promise.all([
      readSourceGrid(item.assets[bands.a].href, drawnBbox, arrays.width, arrays.height, epsg, signal),
      readSourceGrid(item.assets[bands.b].href, drawnBbox, arrays.width, arrays.height, epsg, signal),
    ]);
    if (!gridA || !gridB) return;
    warpItemInto(arrays, [gridA, gridB], drawnBbox, ([va, vb]) => {
      const v = normalizedDifferenceScalar(va, vb);
      return v === null ? null : { r: v, g: v, b: v, valid: true };
    });
    return;
  }

  // 'rgb' (default)
  const [gridR, gridG, gridB] = await Promise.all([
    readSourceGrid(item.assets[bands.r].href, drawnBbox, arrays.width, arrays.height, epsg, signal),
    readSourceGrid(item.assets[bands.g].href, drawnBbox, arrays.width, arrays.height, epsg, signal),
    readSourceGrid(item.assets[bands.b].href, drawnBbox, arrays.width, arrays.height, epsg, signal),
  ]);
  if (!gridR || !gridG || !gridB) return;
  warpItemInto(arrays, [gridR, gridG, gridB], drawnBbox, ([vr, vg, vb]) =>
    (vr === 0 && vg === 0 && vb === 0) ? null : { r: vr, g: vg, b: vb, valid: true });
}

/* ── Streaming composite ──────────────────────────────────────────────── */

/**
 * Warp all contributing items in parallel; call onPartial after each
 * item's bands all arrive and are merged into the mosaic. Returns the same
 * arrays that were streamed — callers can use them for both preview and
 * download.
 */
export async function streamComposite({ items, drawnBbox, mode = 'rgb', bands = { r: 'red', g: 'green', b: 'blue' }, width, height, onPartial, onLog, signal }) {
  const arrays = {
    r: new Float32Array(width * height),
    g: new Float32Array(width * height),
    b: new Float32Array(width * height),
    mask: new Uint8Array(width * height),
    width,
    height,
  };

  const drawnPoly = bboxPolygon(drawnBbox);
  const contributing = items.filter((it) => booleanIntersects(drawnPoly, it));

  await Promise.all(
    contributing.map(async (item, idx) => {
      const epsg = item.properties?.['proj:epsg'] ?? item.properties?.['proj:code'];
      try {
        await warpItem(arrays, item, mode, bands, drawnBbox, epsg, signal);
        onPartial?.(arrays, idx + 1, contributing.length);
      } catch (err) {
        // AbortError means the caller cancelled this fetch (e.g. the user
        // picked a different day/box) — expected, not a real failure.
        if (err.name !== 'AbortError') onLog?.(`Skipped ${item.id}: ${err.message}${err.cause ? ` (${err.cause.code ?? err.cause.message})` : ''}`);
      }
    }),
  );

  return arrays;
}

/* ── Stretch, gamma → ImageData ───────────────────────────────────────── */

/**
 * `mode` gates the colour-map path: it only ever applies to 'single'/'index'
 * data (where r === g === b, one real value per pixel) — 'rgb' mode always
 * uses the plain per-channel stretch, regardless of what `viz.colormap` (or
 * `viz.colormapReversed`) holds. `colormapReversed` flips which end of the
 * stretch maps to which end of the ramp — including for grayscale, since
 * that's just the colour-map path with no LUT applied.
 */
export function renderRGBA({ r, g, b, mask, width, height }, viz, mode = 'rgb') {
  const { vmin, vmax, gamma, colormap, colormapReversed } = viz;
  const rng = (vmax - vmin) || 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const useColormapPath = mode !== 'rgb';
  const lut = useColormapPath ? colormapLUT(colormap) : null;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) { rgba[i * 4 + 3] = 0; continue; }
    if (useColormapPath) {
      let t = stretchT(r[i], vmin, rng, gamma);
      if (colormapReversed) t = 1 - t;
      if (lut) {
        const li = Math.round(t * 255) * 3;
        rgba[i * 4]     = lut[li];
        rgba[i * 4 + 1] = lut[li + 1];
        rgba[i * 4 + 2] = lut[li + 2];
      } else {
        const v = Math.round(t * 255);
        rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v;
      }
    } else {
      rgba[i * 4]     = stretch(r[i], vmin, rng, gamma);
      rgba[i * 4 + 1] = stretch(g[i], vmin, rng, gamma);
      rgba[i * 4 + 2] = stretch(b[i], vmin, rng, gamma);
    }
    rgba[i * 4 + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

function stretchT(v, vmin, rng, gamma) {
  let x = (v - vmin) / rng;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (gamma !== 1) x = Math.pow(x, gamma);
  return x;
}

function stretch(v, vmin, rng, gamma) {
  return Math.round(stretchT(v, vmin, rng, gamma) * 255);
}

/* ── Crop to valid data ───────────────────────────────────────────────── */

/**
 * Bounding box (in pixel coordinates) of the masked-in pixels. Returns
 * `null` when nothing is valid.
 */
export function cropBounds(mask, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[base + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * Crop an ImageData to the bounding box of valid (masked-in) pixels, so
 * downloads don't carry empty borders where no scene covered the box.
 * Returns the original image if everything (or nothing) is valid.
 */
export function cropToValid(img, mask) {
  const { width, height } = img;
  const bounds = cropBounds(mask, width, height);
  if (!bounds) return img; // no valid data — keep as-is
  const { x0, y0, x1, y1 } = bounds;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w === width && h === height) return img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * width + x0) * 4;
    out.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return new ImageData(out, w, h);
}

/**
 * The WGS-84 bbox that a pixel-space crop rectangle corresponds to, given
 * the full output canvas's bbox. Row 0 of the canvas is the box's north
 * edge (rasters are north-up), so y grows southward.
 */
export function bboxForCrop(bbox, width, height, bounds) {
  const [w, s, e, n] = bbox;
  const px = (e - w) / width;
  const py = (n - s) / height;
  return [
    w + bounds.x0 * px,
    n - (bounds.y1 + 1) * py,
    w + (bounds.x1 + 1) * px,
    n - bounds.y0 * py,
  ];
}

/* ── Encode ───────────────────────────────────────────────────────────── */

export async function toBlob(img, format = 'png', quality = 0.92) {
  return new Blob([encodeImage(img, format, Math.round(quality * 100))], { type: MIME[format] ?? MIME.png });
}

export async function toBlobURL(img, format = 'png') {
  return URL.createObjectURL(await toBlob(img, format));
}

/**
 * Encode the *raw, uncropped-stretch* mosaic arrays as a georeferenced
 * GeoTIFF — not the vmin/vmax/gamma/colormap-stretched display pixels
 * PNG/JPG save. One band for 'single'/'index' (r, since r === g === b
 * there), three for 'rgb'. Cropped to the same valid-data bounding box as
 * PNG/JPG.
 *
 * 'rgb'/'single' are reflectance DN — the same uint16 sample type the
 * source Sentinel-2 COGs use — with masked-out pixels written as `0` (the
 * same nodata convention already used for that raw DN elsewhere in the
 * app). 'index' values (e.g. NDVI's -1..1) can't be represented that way,
 * so it stays float32, with masked-out pixels as `NaN` — reusing `0`
 * there would be wrong, since an index value of exactly 0 is real data.
 */
export function toGeoTIFFBlob(arrays, drawnBbox, mode = 'rgb') {
  const { r, g, b, mask, width, height } = arrays;
  const bounds = cropBounds(mask, width, height);
  const x0 = bounds ? bounds.x0 : 0;
  const y0 = bounds ? bounds.y0 : 0;
  const cropW = bounds ? bounds.x1 - bounds.x0 + 1 : width;
  const cropH = bounds ? bounds.y1 - bounds.y0 + 1 : height;
  const bbox = bounds ? bboxForCrop(drawnBbox, width, height, bounds) : drawnBbox;

  const bands = mode === 'rgb' ? [r, g, b] : [r];
  const numBands = bands.length;
  const isIndex = mode === 'index';
  const interleaved = isIndex
    ? new Float32Array(cropW * cropH * numBands)
    : new Uint16Array(cropW * cropH * numBands);

  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcIdx = (y0 + y) * width + (x0 + x);
      const dstBase = (y * cropW + x) * numBands;
      const valid = mask[srcIdx];
      for (let bi = 0; bi < numBands; bi++) {
        if (!valid) {
          interleaved[dstBase + bi] = isIndex ? NaN : 0;
          continue;
        }
        // Uint16Array assignment truncates and wraps rather than rounding
        // and clamping, so do both explicitly first.
        interleaved[dstBase + bi] = isIndex ? bands[bi][srcIdx] : Math.max(0, Math.min(65535, Math.round(bands[bi][srcIdx])));
      }
    }
  }

  const [w, s, e, n] = bbox;
  const arrayBuffer = writeArrayBuffer(interleaved, {
    width: cropW,
    height: cropH,
    ModelPixelScale: [(e - w) / cropW, (n - s) / cropH, 0],
    ModelTiepoint: [0, 0, 0, w, n, 0],
    GeographicTypeGeoKey: 4326,
    GeogCitationGeoKey: 'WGS 84',
    GTModelTypeGeoKey: 2,
    GDAL_NODATA: isIndex ? 'nan' : '0',
  });
  return { blob: new Blob([arrayBuffer], { type: 'image/tiff' }), width: cropW, height: cropH };
}
