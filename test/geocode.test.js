import { describe, it, expect, vi, afterEach } from 'vitest';
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a slugified name from the reverse-geocode response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ address: { city: 'Canberra' } }),
    }));
    expect(await placeName(149.13, -35.28)).toBe('canberra');
  });

  it('returns null (not throw) when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await placeName(1.23456, 2.34567)).toBeNull();
  });

  it('returns null when the response has no usable address field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(await placeName(3.456, 4.567)).toBeNull();
  });

  it('prefers the matched feature\'s own name over broad admin fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'Cradle Mountain', address: { state: 'Tasmania', country: 'Australia' } }),
    }));
    expect(await placeName(145.95, -41.68)).toBe('cradle-mountain');
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
