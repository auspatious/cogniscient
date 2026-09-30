/* PNG/JPG encoding shared by the web app and the CLI — pure JS, so both
   produce identical bytes (no canvas, which Node lacks). */

import { encode as encodePng } from 'fast-png';
import jpeg from 'jpeg-js';

export const MIME = { png: 'image/png', jpg: 'image/jpeg' };

// jpeg-js's encoder returns Buffer.from(...) when bundled, and browsers have
// none. The stand-in is installed only for this synchronous call: geotiff
// picks Node vs browser workers with `typeof Buffer`, so leaving a fake
// global behind breaks every COG read.
function encodeJpeg(img, quality) {
  const fake = typeof Buffer === 'undefined';
  if (fake) globalThis.Buffer = { from: (bytes) => Uint8Array.from(bytes) };
  try {
    return new Uint8Array(jpeg.encode(img, quality).data);
  } finally {
    if (fake) delete globalThis.Buffer;
  }
}

/** Encodes ImageData-shaped `{ data, width, height }` (RGBA) to PNG or JPG bytes. */
export function encodeImage({ data, width, height }, format = 'png', quality = 92) {
  if (format === 'jpg') return encodeJpeg({ data, width, height }, quality);
  return encodePng({ data, width, height, depth: 8, channels: 4 });
}
