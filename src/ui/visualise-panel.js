import { state, set, setViz, subscribe, DEFAULT_STATE } from '../state.js';
import { COLORMAPS } from '../colormap.js';

// Sentinel-2 L2A bands as exposed by Earth Search asset keys.
const BANDS = [
  { key: 'coastal', label: 'Coastal' },
  { key: 'blue', label: 'Blue' },
  { key: 'green', label: 'Green' },
  { key: 'red', label: 'Red' },
  { key: 'rededge1', label: 'RedEdge1' },
  { key: 'rededge2', label: 'RedEdge2' },
  { key: 'rededge3', label: 'RedEdge3' },
  { key: 'nir', label: 'NIR' },
  { key: 'nir08', label: 'NIR narrow' },
  { key: 'nir09', label: 'WaterVap' },
  { key: 'swir16', label: 'SWIR1' },
  { key: 'swir22', label: 'SWIR2' },
];

const CHANNELS = ['r', 'g', 'b'];

// Common combinations. 'custom' is a no-op marker: it just reflects that
// the user has hand-edited a band picker away from any of the above.
const PRESETS = [
  { id: 'true-color', label: 'True colour (RGB)', mode: 'rgb', bands: { r: 'red', g: 'green', b: 'blue' }, viz: { vmin: 0, vmax: 3000, gamma: 1, colormap: 'gray' } },
  { id: 'false-color', label: 'False colour (NIR-R-G)', mode: 'rgb', bands: { r: 'nir', g: 'red', b: 'green' }, viz: { vmin: 0, vmax: 3000, gamma: 1, colormap: 'gray' } },
  { id: 'ndvi', label: 'NDVI (vegetation index)', mode: 'index', indexBands: { a: 'nir', b: 'red' }, viz: { vmin: -1, vmax: 1, gamma: 1, colormap: 'rdylgn' } },
  { id: 'ndbi', label: 'NDBI (built-up index)', mode: 'index', indexBands: { a: 'swir16', b: 'nir' }, viz: { vmin: -1, vmax: 1, gamma: 1, colormap: 'rdbu' } },
  { id: 'mndwi', label: 'MNDWI (water index)', mode: 'index', indexBands: { a: 'green', b: 'swir16' }, viz: { vmin: -1, vmax: 1, gamma: 1, colormap: 'rdbu' } },
  { id: 'ndwi', label: 'NDWI (water index)', mode: 'index', indexBands: { a: 'green', b: 'nir' }, viz: { vmin: -1, vmax: 1, gamma: 1, colormap: 'rdbu' } },
  { id: 'ndmi', label: 'NDMI (vegetation moisture)', mode: 'index', indexBands: { a: 'nir', b: 'swir16' }, viz: { vmin: -1, vmax: 1, gamma: 1, colormap: 'brbg' } },
  { id: 'ndre', label: 'NDRE (red edge / chlorophyll)', mode: 'index', indexBands: { a: 'nir', b: 'rededge1' }, viz: { vmin: -1, vmax: 1, gamma: 1, colormap: 'rdylgn' } },
  { id: 'nbr', label: 'NBR (burn severity)', mode: 'index', indexBands: { a: 'nir', b: 'swir22' }, viz: { vmin: -1, vmax: 1, gamma: 1, colormap: 'rdylgn' } },
  { id: 'single', label: 'Single band', mode: 'single', singleBand: 'nir', viz: { vmin: 0, vmax: 3000, gamma: 1, colormap: 'gray' } },
  { id: 'custom', label: 'Custom', mode: null },
];

// Reflectance DN (rgb/single) and normalized-difference indices (index)
// live on very different scales, so the vmin/vmax sliders need different
// ranges depending on vizMode.
const RANGES = {
  rgb:    { vmin: [0, 15000, 50], vmax: [0, 15000, 50], gamma: [0.05, 2, 0.05] },
  single: { vmin: [0, 15000, 50], vmax: [0, 15000, 50], gamma: [0.05, 2, 0.05] },
  index:  { vmin: [-1, 1, 0.01], vmax: [-1, 1, 0.01], gamma: [0.05, 2, 0.05] },
};
const VIZ_KEYS = ['vmin', 'vmax', 'gamma'];

function rangesFor(mode) {
  return RANGES[mode] ?? RANGES.rgb;
}

// Minimum gap enforced between vmin and vmax so the stretch never inverts —
// scaled to the slider's own step size (1 for DN, 0.01 for indices).
function minGap(mode) {
  return mode === 'index' ? 0.01 : 1;
}

function bandOptions(selected) {
  return BANDS.map((b) => `<option value="${b.key}" ${selected === b.key ? 'selected' : ''}>${b.label}</option>`).join('');
}

function applyPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset || preset.mode === null) {
    set({ preset: id }); // 'custom': label only, leaves bands/mode/viz untouched
    return;
  }
  set({
    preset: id,
    vizMode: preset.mode,
    ...(preset.bands ? { bands: preset.bands } : {}),
    ...(preset.singleBand ? { singleBand: preset.singleBand } : {}),
    ...(preset.indexBands ? { indexBands: preset.indexBands } : {}),
    viz: { ...state.viz, ...preset.viz },
  });
}

function resetToDefaults() {
  set({
    preset: DEFAULT_STATE.preset,
    vizMode: DEFAULT_STATE.vizMode,
    bands: { ...DEFAULT_STATE.bands },
    singleBand: DEFAULT_STATE.singleBand,
    indexBands: { ...DEFAULT_STATE.indexBands },
    viz: { ...DEFAULT_STATE.viz },
  });
}

// Rebuilds just the mode-specific band pickers, and marks the preset
// selector "Custom" the moment the user hand-edits one away from a preset.
function renderBandControls(panelEl) {
  const container = panelEl.querySelector('#band-controls');
  const presetSelect = panelEl.querySelector('#preset');
  const markCustom = (patch) => {
    set({ preset: 'custom', ...patch });
    if (presetSelect) presetSelect.value = 'custom';
  };

  if (state.vizMode === 'single') {
    container.innerHTML = `
      <div class="field">
        <label for="band-single">Band</label>
        <select id="band-single">${bandOptions(state.singleBand)}</select>
      </div>`;
    container.querySelector('#band-single').addEventListener('change', (e) => {
      markCustom({ singleBand: e.target.value });
    });
  } else if (state.vizMode === 'index') {
    container.innerHTML = `
      <p class="hint">Index = (A − B) / (A + B)</p>
      <div class="row">
        <div class="field">
          <label for="band-a">A</label>
          <select id="band-a">${bandOptions(state.indexBands.a)}</select>
        </div>
        <div class="field">
          <label for="band-b">B</label>
          <select id="band-b">${bandOptions(state.indexBands.b)}</select>
        </div>
      </div>`;
    container.querySelector('#band-a').addEventListener('change', (e) => {
      markCustom({ indexBands: { ...state.indexBands, a: e.target.value } });
    });
    container.querySelector('#band-b').addEventListener('change', (e) => {
      markCustom({ indexBands: { ...state.indexBands, b: e.target.value } });
    });
  } else {
    // 'rgb'
    container.innerHTML = `
      <div class="row">
        ${CHANNELS.map((ch) => `
          <div class="field">
            <label for="band-${ch}">${ch.toUpperCase()}</label>
            <select id="band-${ch}">${bandOptions(state.bands[ch])}</select>
          </div>`).join('')}
      </div>`;
    for (const ch of CHANNELS) {
      container.querySelector(`#band-${ch}`).addEventListener('change', (e) => {
        markCustom({ bands: { ...state.bands, [ch]: e.target.value } });
      });
    }
  }
}

export function renderVisualisePanel(el) {
  function build() {
    const ranges = rangesFor(state.vizMode);
    const showColormap = state.vizMode !== 'rgb';

    el.innerHTML = `
      <h2>Visualise</h2>
      <div class="field">
        <div class="field-header">
          <label for="preset">Preset</label>
          <button type="button" id="reset-viz" class="small-btn" title="Back to true colour, all defaults">Reset</button>
        </div>
        <select id="preset">
          ${PRESETS.map((p) => `<option value="${p.id}" ${state.preset === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}
        </select>
      </div>
      <div id="band-controls"></div>
      ${showColormap ? `
        <div class="field">
          <div class="field-header">
            <label for="colormap">Colour map</label>
            <label class="checkbox-label"><input type="checkbox" id="colormap-reverse" ${state.viz.colormapReversed ? 'checked' : ''} /> Reverse</label>
          </div>
          <select id="colormap">
            ${COLORMAPS.map((c) => `<option value="${c.id}" ${state.viz.colormap === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
        </div>
      ` : ''}
      ${field('vmin', ...ranges.vmin, state.viz.vmin, state.vizMode)}
      ${field('vmax', ...ranges.vmax, state.viz.vmax, state.vizMode)}
      ${field('gamma', ...ranges.gamma, state.viz.gamma, state.vizMode)}
    `;

    // Always rebuild after a preset change, not just when vizMode itself
    // changes — e.g. NDVI -> NDBI stays in 'index' mode but still needs to
    // pick up different index bands and a different colour map.
    el.querySelector('#preset').addEventListener('change', (e) => {
      applyPreset(e.target.value);
      build();
    });
    el.querySelector('#reset-viz').addEventListener('click', () => {
      resetToDefaults();
      build();
    });

    renderBandControls(el);

    if (showColormap) {
      el.querySelector('#colormap').addEventListener('change', (e) => setViz({ colormap: e.target.value }));
      el.querySelector('#colormap-reverse').addEventListener('change', (e) => setViz({ colormapReversed: e.target.checked }));
    }

    for (const key of VIZ_KEYS) {
      const input = el.querySelector(`[data-input="${key}"]`);
      const label = el.querySelector(`[data-val="${key}"]`);
      input.addEventListener('input', (e) => {
        let v = Number(e.target.value);
        // Keep vmin < vmax — an inverted range silently breaks the stretch.
        const gap = minGap(state.vizMode);
        if (key === 'vmin') v = Math.min(v, state.viz.vmax - gap);
        if (key === 'vmax') v = Math.max(v, state.viz.vmin + gap);
        if (v !== Number(e.target.value)) input.value = String(v);
        setViz({ [key]: v });
        label.textContent = format(key, v, state.vizMode);
      });
    }
  }

  build();

  // Sync slider values from outside (e.g. a future auto-stretch feature)
  // without a full rebuild — don't overwrite a focused slider, that would
  // tug it out of the user's hand. Full rebuilds (band pickers, colour
  // map, slider ranges) only ever happen via the preset select's own
  // handler above, since that's the sole place vizMode/bands/colormap
  // change from.
  let last = { ...state.viz };
  subscribe((s) => {
    for (const key of VIZ_KEYS) {
      if (s.viz[key] === last[key]) continue;
      last[key] = s.viz[key];
      const input = el.querySelector(`[data-input="${key}"]`);
      const label = el.querySelector(`[data-val="${key}"]`);
      if (input && document.activeElement !== input) input.value = String(s.viz[key]);
      if (label) label.textContent = format(key, s.viz[key], s.vizMode);
    }
  });
}

function field(key, min, max, step, value, mode) {
  return `
    <div class="field">
      <label>${key} <span data-val="${key}">${format(key, value, mode)}</span></label>
      <input data-input="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" />
    </div>`;
}

function format(key, v, mode) {
  if (key === 'gamma' || mode === 'index') return v.toFixed(2);
  return String(Math.round(v));
}
