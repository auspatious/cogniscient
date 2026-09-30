import { describe, it, expect } from 'vitest';
import { decode as decodePng } from 'fast-png';
import jpeg from 'jpeg-js';
import { encodeImage } from '../src/encode.js';

const img = {
  width: 2,
  height: 2,
  data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 0]),
};

describe('encodeImage', () => {
  it('round-trips a PNG losslessly', () => {
    const out = decodePng(encodeImage(img, 'png'));
    expect([out.width, out.height]).toEqual([2, 2]);
    expect([...out.data]).toEqual([...img.data]);
  });

  it('writes a decodable JPEG of the right size', () => {
    const bytes = encodeImage(img, 'jpg');
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]); // SOI
    const out = jpeg.decode(bytes, { useTArray: true });
    expect([out.width, out.height]).toEqual([2, 2]);
  });

  it("doesn't leave a fake Buffer global behind in buffer-less environments", () => {
    const real = globalThis.Buffer;
    delete globalThis.Buffer;
    try {
      const bytes = encodeImage(img, 'jpg');
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
      expect(typeof Buffer).toBe('undefined'); // geotiff sniffs this to pick its worker type
    } finally {
      globalThis.Buffer = real;
    }
  });
});
