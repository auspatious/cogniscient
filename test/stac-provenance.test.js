import { describe, it, expect } from 'vitest';
import { buildStacProvenance } from '../src/stac-provenance.js';

describe('buildStacProvenance', () => {
  const baseState = {
    drawnBbox: [150, -35, 151, -34],
    selectedDay: '2026-02-03',
    collection: 'sentinel-2-l2a',
    vizMode: 'rgb',
    bands: { r: 'red', g: 'green', b: 'blue' },
    singleBand: 'nir',
    indexBands: { a: 'nir', b: 'red' },
    viz: { vmin: 0, vmax: 3000, gamma: 1, colormap: 'gray', colormapReversed: false, format: 'png' },
  };

  it('builds a STAC item with derived_from links to source scene self URLs', () => {
    const out = buildStacProvenance({
      appState: baseState,
      sourceItems: [
        { id: 'scene-a', links: [{ rel: 'self', href: 'https://example.com/a.json' }] },
        { id: 'scene-b', links: [{ rel: 'self', href: 'https://example.com/b.json' }] },
      ],
    });

    expect(out.stac_version).toBe('1.0.0');
    expect(out.stac_extensions).toContain('https://stac-extensions.github.io/processing/v1.1.0/schema.json');
    expect(out.bbox).toEqual(baseState.drawnBbox);
    expect(out.properties.datetime).toBe('2026-02-03T00:00:00Z');
    // A string per the processing extension schema, not an array — a
    // viewer expecting a string silently shows nothing for the wrong type.
    expect(typeof out.properties['processing:lineage']).toBe('string');
    expect(out.properties['processing:lineage']).toContain('scene-a');
    expect(out.properties['processing:lineage']).toContain('scene-b');
    expect(out.links.filter((l) => l.rel === 'derived_from').map((l) => l.href)).toEqual([
      'https://example.com/a.json',
      'https://example.com/b.json',
    ]);
  });

  it('still writes a string processing:lineage when there are no source items', () => {
    const out = buildStacProvenance({ appState: baseState, sourceItems: [] });
    expect(out.properties['processing:lineage']).toBe('No source scenes recorded.');
  });

  it('records selected bands and stretch settings for index mode', () => {
    const out = buildStacProvenance({
      appState: {
        ...baseState,
        vizMode: 'index',
        indexBands: { a: 'swir16', b: 'nir' },
        viz: { ...baseState.viz, vmin: -1, vmax: 1, colormap: 'rdylgn', colormapReversed: true },
      },
      sourceItems: [],
    });

    expect(out.properties['cogniscient:visualisation'].selected_bands).toEqual({
      mode: 'index',
      bands: { a: 'swir16', b: 'nir' },
      expression: '(a - b) / (a + b)',
    });
    expect(out.properties['cogniscient:visualisation'].stretch).toEqual({
      vmin: -1,
      vmax: 1,
      gamma: 1,
      colormap: 'rdylgn',
      colormap_reversed: true,
    });
  });

  it('omits colormap from the stretch in rgb mode, since it has no effect there', () => {
    const out = buildStacProvenance({ appState: baseState, sourceItems: [] });
    expect(out.properties['cogniscient:visualisation'].stretch).toEqual({ vmin: 0, vmax: 3000, gamma: 1 });
  });

  it('always links to the webapp, and to a reproduce URL only when one is given', () => {
    const withoutReproduce = buildStacProvenance({ appState: baseState, sourceItems: [] });
    expect(withoutReproduce.links).toContainEqual({
      rel: 'about', href: 'https://cogniscient.auspatious.com/', type: 'text/html', title: 'Generated with Cogniscient',
    });
    expect(withoutReproduce.links.some((l) => l.rel === 'alternate')).toBe(false);

    const withReproduce = buildStacProvenance({
      appState: baseState, sourceItems: [], reproduceUrl: 'https://cogniscient.auspatious.com/?bbox=1_2_3_4',
    });
    expect(withReproduce.links).toContainEqual({
      rel: 'alternate', href: 'https://cogniscient.auspatious.com/?bbox=1_2_3_4', type: 'text/html', title: 'Reproduce this export in Cogniscient',
    });
  });

  it('has no assets when no exportFilename is given', () => {
    expect(buildStacProvenance({ appState: baseState, sourceItems: [] }).assets).toEqual({});
  });

  it("gives a tif export a 'data' role asset with a geotiff media type", () => {
    const out = buildStacProvenance({
      appState: { ...baseState, viz: { ...baseState.viz, format: 'tif' } },
      sourceItems: [],
      exportFilename: 'cogniscient-2026-02-03-rgb-red-green-blue-1000px.tif',
    });
    expect(out.assets.data).toEqual({
      href: 'cogniscient-2026-02-03-rgb-red-green-blue-1000px.tif',
      type: 'image/tiff; application=geotiff',
      roles: ['data'],
      title: 'Exported GeoTIFF',
    });
  });

  it("gives a png/jpg export a 'visual' role asset with an image media type", () => {
    const out = buildStacProvenance({
      appState: baseState, // format: 'png'
      sourceItems: [],
      exportFilename: 'cogniscient-2026-02-03-rgb-red-green-blue-1000px.png',
    });
    expect(out.assets.visual).toEqual({
      href: 'cogniscient-2026-02-03-rgb-red-green-blue-1000px.png',
      type: 'image/png',
      roles: ['visual'],
      title: 'Exported image',
    });
  });
});
