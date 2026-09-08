import { state, set, subscribe, HARD_LIMIT_KM2 } from '../state.js';
import { nativePixelWidth, outputSize, sliderRange } from '../overviews.js';
import { estimateBytes } from '../size-estimate.js';

const MIN_WIDTH = 256;
const STEP = 128;

let lastPaintKey = null;

export function renderAreaPanel(el, { onDraw, onClear, onTogglePreview, isPreviewVisible }) {
  subscribe(() => paint(el, onDraw, onClear, onTogglePreview, isPreviewVisible));
}

function previewToggleHtml(visible) {
  return `
    <button
      id="preview-toggle-btn"
      class="small-btn"
      title="${visible ? 'Hide the exported preview image (and the outside-the-box fade), without losing it — compare against the bare basemap.' : 'Show the exported preview image (and the outside-the-box fade) again.'}"
    >${visible ? 'Hide' : 'Show'}</button>`;
}

function wirePreviewToggle(el, onTogglePreview, isPreviewVisible) {
  const btn = el.querySelector('#preview-toggle-btn');
  btn.addEventListener('click', () => {
    onTogglePreview();
    const visible = isPreviewVisible();
    btn.textContent = visible ? 'Hide' : 'Show';
    btn.title = visible
      ? 'Hide the exported preview image, without losing it — compare against the bare basemap.'
      : 'Show the exported preview image again.';
  });
}

function tierClass(tier) {
  return tier === 'small' ? 'ok' : tier === 'medium' ? 'warn' : 'danger';
}
function tierLabel(tier) {
  return tier === 'too-large' ? 'too large' : tier;
}
function sizeLabel(s) {
  const mPerPx = s.widthMeters / s.width;
  return `${s.width} × ${s.height} px at ${mPerPx.toFixed(1)} m/px`;
}

function paint(el, onDraw, onClear, onTogglePreview, isPreviewVisible) {
  const bbox = state.drawnBbox;

  if (!bbox) {
    if (lastPaintKey === 'empty') return;
    lastPaintKey = 'empty';
    el.innerHTML = `
      <div class="field-header">
        <h2>Area</h2>
        ${previewToggleHtml(isPreviewVisible())}
      </div>
      <button id="draw-btn">Draw rectangle</button>
      <p class="hint">Click, then click-drag on the map to pick your area.</p>
    `;
    el.querySelector('#draw-btn').addEventListener('click', onDraw);
    wirePreviewToggle(el, onTogglePreview, isPreviewVisible);
    return;
  }

  const nativeMax = nativePixelWidth(bbox, state.nativeGSD);
  const { min: sliderMin, max: sliderMax, collapsed } = sliderRange(nativeMax, MIN_WIDTH, STEP);
  // Collapsed = native resolution is the only achievable size (outputSize
  // always clamps to it) — pin to it rather than whatever targetWidth was
  // left over from a previous, larger box.
  const currentWidth = collapsed ? sliderMax : Math.min(Math.max(state.targetWidth, sliderMin), sliderMax);
  const overLimit = state.drawnAreaKm2 > HARD_LIMIT_KM2;

  // Clamp state to slider range if needed (one clean write).
  if (state.targetWidth !== currentWidth) {
    set({ targetWidth: currentWidth });
    return; // subscribe will re-invoke paint with the clamped value
  }

  const itemCount = state.itemsByDay.find((g) => g.day === state.selectedDay)?.items.length ?? 1;
  const bandCount = state.vizMode === 'single' ? 1 : state.vizMode === 'index' ? 2 : 3;
  const sizeNow = outputSize(bbox, currentWidth, state.nativeGSD);
  const estNow = estimateBytes({ width: sizeNow.width, height: sizeNow.height, itemCount, bands: bandCount });

  // Skip DOM rebuild when nothing this panel shows has changed — otherwise
  // unrelated state emits (e.g. loading progress) yank the slider mid-drag.
  const paintKey = `${bbox.join(',')}|${currentWidth}|${sliderMin}|${collapsed}|${itemCount}|${overLimit}|${bandCount}`;
  if (paintKey === lastPaintKey) return;
  lastPaintKey = paintKey;

  el.innerHTML = `
    <div class="field-header">
      <h2>Area <span class="badge">${overLimit ? 'too large' : 'ready'}</span></h2>
      ${previewToggleHtml(isPreviewVisible())}
    </div>
    <div class="row">
      <button id="draw-btn">Redraw</button>
      <button id="clear-btn" class="secondary">Clear</button>
    </div>
    <p class="hint">${state.drawnAreaKm2.toFixed(1)} km² · box native max <b>${nativeMax} px</b> at ${state.nativeGSD} m/px.</p>
    <div class="field">
      <label>Output size <span id="tw-val">${sizeLabel(sizeNow)}</span></label>
      <input id="tw" type="range" min="${sliderMin}" max="${sliderMax}" step="${STEP}" value="${currentWidth}" ${collapsed ? 'disabled title="Already at native resolution — nothing smaller to choose from"' : ''} />
    </div>
    <div id="tw-badge"><span class="badge ${tierClass(estNow.tier)}">fetches ~${estNow.megabytes.toFixed(0)} MB · ${tierLabel(estNow.tier)}</span></div>
    ${overLimit ? `<p class="hint" style="color:var(--danger)">Exceeds ${HARD_LIMIT_KM2.toLocaleString()} km² hard limit — redraw smaller.</p>` : ''}
  `;

  el.querySelector('#draw-btn').addEventListener('click', onDraw);
  el.querySelector('#clear-btn').addEventListener('click', onClear);
  wirePreviewToggle(el, onTogglePreview, isPreviewVisible);

  const tw = el.querySelector('#tw');
  const twVal = el.querySelector('#tw-val');
  const twBadge = el.querySelector('#tw-badge');

  // Live estimate while dragging (no state write, no refetch).
  tw.addEventListener('input', (e) => {
    const w = Number(e.target.value);
    const s = outputSize(bbox, w, state.nativeGSD);
    const est = estimateBytes({ width: s.width, height: s.height, itemCount, bands: bandCount });
    twVal.textContent = sizeLabel(s);
    twBadge.innerHTML = `<span class="badge ${tierClass(est.tier)}">fetches ~${est.megabytes.toFixed(0)} MB · ${tierLabel(est.tier)}</span>`;
  });

  // Commit on release → triggers refetch.
  tw.addEventListener('change', (e) => {
    set({ targetWidth: Number(e.target.value) });
  });
}
