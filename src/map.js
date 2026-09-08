import { Map, NavigationControl, ScaleControl, GeolocateControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// maplibre-gl v5 (unlike v6) bundles/resolves its worker itself — no
// setWorkerUrl()/explicit worker import needed for Vite to build cleanly.

// Public client-side key, locked to allowed origins in the MapTiler dashboard.
const MAPTILER_KEY = 'ZUYgDOuttJIaWHdE632Y';
const MAPTILER_STYLE = `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${MAPTILER_KEY}`;
const MAPTILER_SATELLITE_STYLE = `https://api.maptiler.com/maps/satellite/style.json?key=${MAPTILER_KEY}`;

export const BASEMAPS = [
  { id: 'map', label: 'Map', short: 'MAP', style: MAPTILER_STYLE },
  { id: 'satellite', label: 'Satellite', short: 'SAT', style: MAPTILER_SATELLITE_STYLE },
];

export function setBasemap(map, id) {
  const basemap = BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
  map.setStyle(basemap.style);
}

/**
 * A small MapLibre control: a single button styled like the other
 * top-right control groups (NavigationControl etc). `label()`/`title()`
 * are called on add and on every `.refresh()` to reflect current state —
 * generic: `onClick` decides what actually happens on click.
 */
export function createToggleControl({ label, title, onClick }) {
  let container, button;
  return {
    onAdd() {
      container = document.createElement('div');
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'basemap-toggle-btn';
      button.addEventListener('click', onClick);
      container.appendChild(button);
      this.refresh();
      return container;
    },
    onRemove() {
      container.remove();
    },
    refresh() {
      button.textContent = label();
      button.title = title();
    },
  };
}

// Fallback for origins the MapTiler key doesn't allow (e.g. local dev).
const OSM_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

export function createMap(container, initialBasemapId = 'map') {
  const initial = BASEMAPS.find((b) => b.id === initialBasemapId) ?? BASEMAPS[0];
  const map = new Map({
    container,
    style: initial.style,
    center: [0, 20],
    zoom: 1,
    hash: true,
  });

  // If the style fails to load (key restricted on this origin), fall back to OSM.
  map.once('error', (e) => {
    if (map.isStyleLoaded()) return;
    console.warn('Basemap style failed, falling back to OSM:', e.error?.message);
    map.setStyle(OSM_STYLE);
  });

  map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new ScaleControl({ maxWidth: 120, unit: 'metric' }));
  map.addControl(new GeolocateControl({ trackUserLocation: false }), 'top-right');

  return map;
}
