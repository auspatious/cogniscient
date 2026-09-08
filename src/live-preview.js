/**
 * PARKED EXPERIMENT (this branch only, not merged to main) — live,
 * GPU-reprojected preview of every scene for the selected day, via
 * deck.gl-raster's `COGLayer` (adaptive-mesh reprojection on the GPU),
 * layered on top of the existing MapLibre map through `@deck.gl/mapbox`'s
 * `MapboxOverlay`.
 *
 * Deliberately independent of `drawnBbox` (this previews *every* scene
 * found for the day, not a bbox-cropped mosaic) and of the CPU export
 * pipeline in `export.js`, which stays the only path that produces a
 * download — this is browsing, not a source of truth for anything saved.
 *
 * Always true-color RGB, by design — each scene renders via its own
 * pre-stretched 8-bit `visual` COG asset, ignoring `state.viz`/`vizMode`
 * entirely. The full Visualise styling (bands/stretch/colormap/index)
 * applies only to the drawn region's own CPU-composited preview
 * (`export.js`) — a GPU-side pass-through was tried and reverted (grey/
 * blank tiles from `MultiCOGLayer`'s multi-band compositing).
 *
 * Why this is parked rather than merged: neither of deck.gl-mapbox's two
 * integration modes gives both correct behaviour at once —
 * `interleaved: true` gets real `beforeId` z-ordering (so footprints/the
 * drawn box/the fade mask render above it) but its shared-canvas/event
 * handling breaks the rectangle-draw cursor and live drag rendering;
 * `interleaved: false` (current setting) restores correct drawing
 * behaviour but the live preview then always renders above everything
 * else, with no z-order control. Confirmed by directly toggling the flag
 * and observing each failure mode — not a guess. Revisit if deck.gl-raster
 * matures, or if `main.js`'s box-drawing interaction can be decoupled from
 * whatever's causing the interleaved-mode interference.
 */
import { MapboxOverlay } from '@deck.gl/mapbox';
import { COGLayer } from '@developmentseed/deck.gl-geotiff';
import { state, subscribe } from './state.js';
import { log } from './log.js';

export function initLivePreview(map, { getBeforeId }) {
  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay);

  function currentItems() {
    const group = state.selectedDay
      ? state.itemsByDay.find((g) => g.day === state.selectedDay)
      : null;
    return group?.items ?? [];
  }

  // Unconditionally (re)builds the COGLayer set from current state. Exposed
  // so main.js can force this whenever the beforeId anchor's availability
  // changes — a basemap switch (all map layers are fresh instances) or the
  // first-ever box/search creating one — even when selectedDay/items
  // themselves haven't.
  function rebuild() {
    const items = currentItems();
    try {
      const layers = items
        .map((item) => {
          const href = item.assets?.visual?.href;
          if (!href) {
            log.warn(`Live preview: ${item.id} has no visual asset, skipped.`);
            return null;
          }
          const beforeId = getBeforeId();
          return new COGLayer({
            id: `live-preview-${item.id}`,
            geotiff: href,
            ...(beforeId ? { beforeId } : {}),
            onGeoTIFFLoad: (_geotiff, { projection, geographicBounds }) => {
              const b = geographicBounds;
              log.info(
                `Live preview: ${item.id} loaded — ${projection?.title ?? '?'} (zone ${projection?.zone ?? '?'}), `
                + `bounds [${b.west.toFixed(2)}, ${b.south.toFixed(2)}, ${b.east.toFixed(2)}, ${b.north.toFixed(2)}]`,
              );
            },
            onTileError: (err) => log.err(`Live preview: ${item.id} tile error — ${err.message ?? err}`),
          });
        })
        .filter(Boolean);
      overlay.setProps({ layers });
      if (items.length) log.info(`Live preview: building ${layers.length} scene layer(s) for ${state.selectedDay}.`);
    } catch (err) {
      log.err(`Live preview failed: ${err.message ?? err}`);
    }
  }

  // Reactive path: only rebuild when the selected day or its scenes
  // actually changed, not on every unrelated state emit.
  let lastKey = null;
  subscribe(() => {
    const key = `${state.selectedDay}|${currentItems().map((i) => i.id).join(';')}`;
    if (key === lastKey) return;
    lastKey = key;
    rebuild();
  });

  return { rebuild };
}
