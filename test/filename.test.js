import { describe, it, expect } from 'vitest';
import { activeBands, bandsSlug } from '../src/filename.js';
import { DEFAULT_STATE } from '../src/state.js';

describe('bandsSlug / activeBands', () => {
  it('describes the bands fetched for each vizMode', () => {
    expect(bandsSlug(DEFAULT_STATE)).toBe('rgb-red-green-blue');
    expect(bandsSlug({ ...DEFAULT_STATE, vizMode: 'single' })).toBe('single-nir');
    expect(bandsSlug({ ...DEFAULT_STATE, vizMode: 'index' })).toBe('index-nir-red');
    expect(activeBands({ ...DEFAULT_STATE, vizMode: 'single' })).toEqual({ band: 'nir' });
  });
});
