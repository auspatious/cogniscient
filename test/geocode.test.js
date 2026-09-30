import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { slugify, placeName, searchPlaces } from '../src/geocode.js';

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('New South Wales')).toBe('new-south-wales');
  });

  it('strips diacritics', () => {
    expect(slugify('Bogotá')).toBe('bogota');
  });

  it('collapses non-alphanumeric runs and trims leading/trailing hyphens', () => {
    expect(slugify(" St. Ives / Cornwall! ")).toBe('st-ives-cornwall');
  });
});

describe('placeName', () => {
  beforeEach(() => {
    // Skip the 1.1s politeness delay between Nominatim requests.
    vi.stubGlobal('setTimeout', (fn) => { fn(); return 0; });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a slugified name from the reverse-geocode response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ address: { city: 'Canberra' } }),
    }));
    expect(await placeName([149.12, -35.29, 149.14, -35.27])).toBe('canberra');
  });

  it('returns null (not throw) when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await placeName([1.2, 2.3, 1.27, 2.37])).toBeNull();
  });

  it('returns null when the response has no usable address field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(await placeName([3.4, 4.5, 3.47, 4.57])).toBeNull();
  });

  it('prefers the matched feature\'s own name over broad admin fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'Cradle Mountain',
        addresstype: 'hamlet',
        address: { state: 'Tasmania', country: 'Australia' },
      }),
    }));
    expect(await placeName([145.94, -41.69, 145.96, -41.67])).toBe('cradle-mountain');
  });

  it('ignores the matched feature\'s own name when it is a road, not a place', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'Campbell Parade',
        addresstype: 'road',
        address: { suburb: 'Bondi Beach', city: 'Sydney' },
      }),
    }));
    expect(await placeName([151.2731, -33.8912, 151.2741, -33.8902])).toBe('bondi-beach');
  });

  it('ignores the matched feature\'s own name when it is a building/amenity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: '',
        addresstype: 'building',
        address: { suburb: 'Bondi Beach', city: 'Sydney' },
      }),
    }));
    expect(await placeName([151.2751, -33.8932, 151.2761, -33.8922])).toBe('bondi-beach');
  });

  it('names the most prominent island in the box when the centre is open water', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ addresstype: 'state', name: 'Tasmania', address: { state: 'Tasmania', country: 'Australia' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ([{ name: 'Tin Kettle Island', importance: 0.358 }, { name: 'Truwana / Cape Barren Island', importance: 0.405 }]) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await placeName([147.93138, -40.40463, 148.46714, -40.17049])).toBe('truwana-cape-barren-island');
    expect(fetchMock.mock.calls[1][0]).toContain('/search?');
    expect(fetchMock.mock.calls[1][0]).toContain('bounded=1');
  });

  it('falls back to the state when no island is found, and skips the search for state-sized boxes', async () => {
    const reverse = { ok: true, json: async () => ({ addresstype: 'state', address: { state: 'Tasmania' } }) };
    const noIslands = vi.fn().mockResolvedValueOnce(reverse).mockResolvedValueOnce({ ok: true, json: async () => ([]) });
    vi.stubGlobal('fetch', noIslands);
    expect(await placeName([147.0, -41.0, 147.4, -40.8])).toBe('tasmania');

    const wide = vi.fn().mockResolvedValue(reverse);
    vi.stubGlobal('fetch', wide);
    expect(await placeName([144, -43, 148.5, -40])).toBe('tasmania');
    expect(wide).toHaveBeenCalledTimes(1); // zoom 6: a state IS the right answer
  });

  it('requests a low (city-level) zoom for a wide, zoomed-out export box', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ name: 'Hobart' }) });
    vi.stubGlobal('fetch', fetchMock);
    await placeName([147.1, -42.95, 147.5, -42.75]); // ~0.4deg wide, city-scale
    expect(fetchMock.mock.calls[0][0]).toContain('zoom=10');
  });

  it('requests a high (building-level) zoom for a small, zoomed-in export box', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ name: 'Bondi Beach' }) });
    vi.stubGlobal('fetch', fetchMock);
    await placeName([151.271, -33.892, 151.274, -33.889]); // ~0.003deg wide, beach-scale
    expect(fetchMock.mock.calls[0][0]).toContain('zoom=18');
  });
});

describe('searchPlaces', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps results and reorders boundingbox [s,n,w,e] into bbox [w,s,e,n]', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([
        { display_name: 'Canberra, Australia', lon: '149.13', lat: '-35.28', boundingbox: ['-35.4', '-35.1', '149.0', '149.2'] },
      ]),
    }));
    const results = await searchPlaces('Canberra');
    expect(results).toEqual([
      { label: 'Canberra, Australia', lon: 149.13, lat: -35.28, bbox: [149.0, -35.4, 149.2, -35.1] },
    ]);
  });

  it('returns [] for blank queries without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await searchPlaces('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns [] (not throw) when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await searchPlaces('Canberra')).toEqual([]);
  });
});
