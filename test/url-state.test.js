import { describe, it, expect } from 'vitest';
import { parseParams, buildParams, urlStateToPatch } from '../src/url-state.js';
import { DEFAULT_STATE, defaultDateRange } from '../src/state.js';

describe('parseParams', () => {
  it('returns {} for an empty query string', () => {
    expect(parseParams('')).toEqual({});
  });

  it('parses bbox as four numbers', () => {
    expect(parseParams('?bbox=1_2_3_4').bbox).toEqual([1, 2, 3, 4]);
  });

  it('ignores a malformed bbox (wrong length or non-numeric)', () => {
    expect(parseParams('?bbox=1_2_3').bbox).toBeUndefined();
    expect(parseParams('?bbox=a_b_c_d').bbox).toBeUndefined();
  });

  it('splits a legacy datetime range into dateFrom/dateTo, without picking a selected day', () => {
    const out = parseParams('?datetime=2026-01-01/2026-02-01');
    expect(out.dateFrom).toBe('2026-01-01');
    expect(out.dateTo).toBe('2026-02-01');
    expect(out.selectedDatetime).toBeUndefined();
  });

  it('treats a single-value datetime as the selected day', () => {
    const out = parseParams('?datetime=2026-01-15');
    expect(out.selectedDatetime).toBe('2026-01-15');
    expect(out.dateFrom).toBeUndefined();
    expect(out.dateTo).toBeUndefined();
  });

  it('parses cloud_cover_max and width as numbers', () => {
    const out = parseParams('?cloud_cover_max=25&width=800');
    expect(out.cloudCoverMax).toBe(25);
    expect(out.width).toBe(800);
  });

  it('passes a legacy selected_datetime through as-is', () => {
    expect(parseParams('?selected_datetime=2026-01-15').selectedDatetime).toBe('2026-01-15');
  });

  it('prefers a legacy selected_datetime over a datetime range, for old links that carried both', () => {
    const out = parseParams('?datetime=2026-01-01/2026-02-01&selected_datetime=2026-01-15');
    expect(out.dateFrom).toBe('2026-01-01');
    expect(out.dateTo).toBe('2026-02-01');
    expect(out.selectedDatetime).toBe('2026-01-15');
  });

  it('passes basemap through as-is', () => {
    expect(parseParams('?basemap=satellite').basemap).toBe('satellite');
  });

  it('parses flat visualise params into a visualiseSettings object', () => {
    const out = parseParams('?preset=ndvi&viz_mode=index&index_bands=nir-red&vmin=-1&vmax=1&colormap=rdylgn&colormap_reversed=1');
    expect(out.visualiseSettings).toEqual({
      preset: 'ndvi',
      vizMode: 'index',
      indexBands: { a: 'nir', b: 'red' },
      viz: { vmin: -1, vmax: 1, colormap: 'rdylgn', colormapReversed: true },
    });
  });

  it('parses bands as a dash-joined triple', () => {
    expect(parseParams('?bands=red-green-blue').visualiseSettings).toEqual({
      bands: { r: 'red', g: 'green', b: 'blue' },
    });
  });

  it('falls back to a legacy visualise_settings JSON blob when no flat params are present', () => {
    const settings = { vizMode: 'index', indexBands: { a: 'nir', b: 'red' } };
    const out = parseParams(`?visualise_settings=${encodeURIComponent(JSON.stringify(settings))}`);
    expect(out.visualiseSettings).toEqual(settings);
  });

  it('ignores malformed legacy visualise_settings JSON instead of throwing', () => {
    expect(() => parseParams('?visualise_settings=not-json')).not.toThrow();
    expect(parseParams('?visualise_settings=not-json').visualiseSettings).toBeUndefined();
  });

  it('prefers flat params over a legacy blob when both are present', () => {
    const legacy = { preset: 'from-legacy' };
    const out = parseParams(`?preset=from-flat&visualise_settings=${encodeURIComponent(JSON.stringify(legacy))}`);
    expect(out.visualiseSettings).toEqual({ preset: 'from-flat' });
  });
});

describe('buildParams', () => {
  const defaultRange = defaultDateRange();
  const defaultState = {
    ...defaultRange,
    drawnBbox: null,
    selectedDay: null,
    cloudCoverMax: DEFAULT_STATE.cloudCoverMax,
    targetWidth: DEFAULT_STATE.targetWidth,
    basemap: DEFAULT_STATE.basemap,
    preset: DEFAULT_STATE.preset,
    vizMode: DEFAULT_STATE.vizMode,
    bands: { ...DEFAULT_STATE.bands },
    singleBand: DEFAULT_STATE.singleBand,
    indexBands: { ...DEFAULT_STATE.indexBands },
    viz: { ...DEFAULT_STATE.viz },
  };

  it('produces no params at all for a state that matches every default', () => {
    const params = buildParams(defaultState, '');
    expect(params.toString()).toBe('');
  });

  it('only writes fields that deviate from default', () => {
    const params = buildParams({ ...defaultState, cloudCoverMax: 25, basemap: 'satellite' }, '');
    expect(params.get('cloud_cover_max')).toBe('25');
    expect(params.get('basemap')).toBe('satellite');
    expect(params.has('preset')).toBe(false);
    expect(params.has('viz_mode')).toBe(false);
    expect(params.has('bands')).toBe(false);
  });

  it('rounds bbox to 5 decimal places, underscore-joined, and always writes it when drawn', () => {
    const params = buildParams({ ...defaultState, drawnBbox: [1.123456789, 2, 3, 4] }, '');
    expect(params.get('bbox')).toBe('1.12346_2_3_4');
  });

  it('omits bbox/datetime when there is no drawn box or selected day', () => {
    const params = buildParams(defaultState, '');
    expect(params.has('bbox')).toBe(false);
    expect(params.has('datetime')).toBe(false);
  });

  it('writes datetime as the selected day (a single value), whenever a day is selected', () => {
    const params = buildParams({ ...defaultState, selectedDay: '2026-01-15' }, '');
    expect(params.get('datetime')).toBe('2026-01-15');
  });

  it('never writes the date range — datetime is only ever the selected day', () => {
    const params = buildParams({ ...defaultState, dateFrom: '2020-01-01', dateTo: '2020-02-01' }, '');
    expect(params.has('datetime')).toBe(false);
  });

  it('clears a stale datetime range from currentSearch when nothing is selected', () => {
    const params = buildParams(defaultState, '?datetime=2020-01-01%2F2020-02-01');
    expect(params.has('datetime')).toBe(false);
  });

  it('drops a stale legacy selected_datetime param it finds in currentSearch', () => {
    const params = buildParams(defaultState, '?selected_datetime=2020-01-01');
    expect(params.has('selected_datetime')).toBe(false);
  });

  it('writes flat visualise params only where they deviate, dash-joined for bands/indexBands', () => {
    const params = buildParams({
      ...defaultState,
      vizMode: 'index',
      preset: 'ndvi',
      indexBands: { a: 'swir16', b: 'green' },
      viz: { ...DEFAULT_STATE.viz, vmin: -1, vmax: 1, colormap: 'rdylgn', colormapReversed: true },
    }, '');
    expect(params.get('viz_mode')).toBe('index');
    expect(params.get('preset')).toBe('ndvi');
    expect(params.get('index_bands')).toBe('swir16-green');
    expect(params.get('vmin')).toBe('-1');
    expect(params.get('vmax')).toBe('1');
    expect(params.get('colormap')).toBe('rdylgn');
    expect(params.get('colormap_reversed')).toBe('1');
    expect(params.has('bands')).toBe(false);
    expect(params.has('gamma')).toBe(false);
  });

  it('drops any legacy visualise_settings param it finds in currentSearch', () => {
    const params = buildParams(defaultState, '?visualise_settings=%7B%22old%22%3Atrue%7D');
    expect(params.has('visualise_settings')).toBe(false);
  });

  it('preserves unrelated existing params', () => {
    const params = buildParams(defaultState, '?utm_source=test');
    expect(params.get('utm_source')).toBe('test');
  });

  it('round-trips a non-default state through parseParams, with no percent-encoded characters', () => {
    const state = {
      ...defaultState,
      drawnBbox: [1.5, 2.5, 3.5, 4.5],
      selectedDay: '2026-01-15',
      cloudCoverMax: 25,
      targetWidth: 800,
      basemap: 'satellite',
      preset: 'ndvi',
      vizMode: 'index',
      indexBands: { a: 'swir16', b: 'green' },
      viz: { ...DEFAULT_STATE.viz, vmin: -1, vmax: 1, colormap: 'rdylgn', colormapReversed: true },
    };
    const params = buildParams(state, '');
    expect(params.toString()).not.toMatch(/%[0-9A-Fa-f]{2}/);

    const out = parseParams(`?${params.toString()}`);
    expect(out.bbox).toEqual(state.drawnBbox);
    expect(out.selectedDatetime).toBe(state.selectedDay);
    expect(out.cloudCoverMax).toBe(state.cloudCoverMax);
    expect(out.width).toBe(state.targetWidth);
    expect(out.basemap).toBe(state.basemap);
    expect(out.visualiseSettings).toEqual({
      preset: 'ndvi',
      vizMode: 'index',
      indexBands: { a: 'swir16', b: 'green' },
      viz: { vmin: -1, vmax: 1, colormap: 'rdylgn', colormapReversed: true },
    });
  });
});

describe('urlStateToPatch', () => {
  it('searches just the shared day when no range is given', () => {
    const patch = urlStateToPatch(parseParams('?datetime=2026-09-20&width=300'), DEFAULT_STATE.viz);
    expect(patch).toMatchObject({ dateFrom: '2026-09-20', dateTo: '2026-09-20', targetWidth: 300 });
  });

  it('merges a partial viz onto the current viz instead of replacing it', () => {
    const patch = urlStateToPatch(parseParams('?vmax=5000&bands=nir-red-green'), DEFAULT_STATE.viz);
    expect(patch.viz).toEqual({ ...DEFAULT_STATE.viz, vmax: 5000 });
    expect(patch.bands).toEqual({ r: 'nir', g: 'red', b: 'green' });
  });
});
