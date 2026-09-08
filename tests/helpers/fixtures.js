/**
 * Test fixtures.
 *
 * Real encoded images produced by sharp rather than checked-in binaries: the
 * suite stays readable, nothing drifts out of sync with the encoder, and the
 * repository holds no opaque blobs.
 */

import sharp from 'sharp';

/**
 * A deterministic RGB gradient with a soft-alpha corner. The gradient gives
 * lossy encoders something real to compress, so size assertions are meaningful.
 */
export function rawGradient(width = 64, height = 48) {
  const channels = 4;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      data[i] = Math.round((x / Math.max(1, width - 1)) * 255);
      data[i + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      data[i + 2] = (x * y) % 256;
      data[i + 3] = x < width / 4 && y < height / 4 ? 128 : 255;
    }
  }
  return { data, info: { width, height, channels } };
}

const fromRaw = (width, height) => {
  const { data, info } = rawGradient(width, height);
  return sharp(data, { raw: info });
};

export const makeJpeg = (w = 64, h = 48, opts = {}) =>
  fromRaw(w, h).flatten({ background: '#ffffff' }).jpeg({ quality: 90, ...opts }).toBuffer();

export const makePng = (w = 64, h = 48) => fromRaw(w, h).png({ compressionLevel: 6 }).toBuffer();

export const makeGif = (w = 64, h = 48) => fromRaw(w, h).gif().toBuffer();

export const makeTiff = (w = 64, h = 48) => fromRaw(w, h).tiff().toBuffer();

export const makeWebp = (w = 64, h = 48) => fromRaw(w, h).webp({ quality: 80 }).toBuffer();

export const makeBmp = async (w = 16, h = 16) => {
  // sharp cannot write BMP, so build a minimal 24-bit BITMAPINFOHEADER file.
  const rowStride = Math.ceil((w * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowStride * h);
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixels.length, 2); // file size
  header.writeUInt32LE(54, 10); // pixel data offset
  header.writeUInt32LE(40, 14); // DIB header size
  header.writeInt32LE(w, 18);
  header.writeInt32LE(h, 22);
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(24, 28); // bits per pixel
  header.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([header, pixels]);
};

/**
 * A JPEG carrying an EXIF orientation tag, to prove the pipeline rotates
 * before it resizes.
 */
export const makeRotatedJpeg = async (w = 64, h = 32, orientation = 6) =>
  // `withExif({ IFD0: { Orientation } })` is normalised away by sharp;
  // `withMetadata({ orientation })` is the setter that actually sticks.
  fromRaw(w, h).flatten({ background: '#fff' })
    .withMetadata({ orientation })
    .jpeg()
    .toBuffer();

/** A PNG whose IHDR claims an absurd canvas, without the pixels to match. */
export function makePixelBombHeader(width = 60000, height = 60000) {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

/** Bytes that match no image signature. */
export const notAnImage = () => Buffer.from('this is plainly not an image at all', 'utf8');

/** A file that starts like a JPEG but stops mid-stream. */
export const truncatedJpeg = async () => (await makeJpeg()).subarray(0, 64);
