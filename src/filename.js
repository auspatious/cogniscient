import { placeName } from './geocode.js';

/** The band selection that's actually fetched for the current vizMode. */
export function activeBands(appState) {
  if (appState.vizMode === 'single') return { band: appState.singleBand };
  if (appState.vizMode === 'index') return appState.indexBands;
  return appState.bands;
}

// Filename-friendly description of what's in the image, e.g.
// "rgb-red-green-blue", "single-nir", "index-nir-red".
export function bandsSlug(appState) {
  const b = activeBands(appState);
  if (appState.vizMode === 'single') return `single-${b.band}`;
  if (appState.vizMode === 'index') return `index-${b.a}-${b.b}`;
  return `rgb-${b.r}-${b.g}-${b.b}`;
}

export async function exportBaseFilename(appState, outWidth) {
  const place = await placeName(appState.drawnBbox);
  const suffix = place ? `-${place}` : '';
  return `cogniscient-${appState.selectedDay}-${bandsSlug(appState)}-${outWidth}px${suffix}`;
}
