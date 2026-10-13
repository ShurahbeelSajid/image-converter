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

/** A multi-page image - TIFF pages or GIF/WebP frames - one flat colour each. */
export async function makeMultiPage(format = 'tiff', colours = ['#ff0000', '#00ff00', '#0000ff']) {
  const frames = await Promise.all(colours.map((background) =>
    sharp({ create: { width: 40, height: 30, channels: 3, background } }).png().toBuffer()));
  return sharp(frames, { join: { animated: true } })[format]().toBuffer();
}

/** Colours of the four quadrants, in reading order. */
export const QUADRANT_COLOURS = Object.freeze({
  R: [255, 0, 0], G: [0, 255, 0], B: [0, 0, 255], Y: [255, 255, 0],
});

/**
 * A JPEG whose stored quadrants are red, green, blue and yellow (reading
 * order), tagged with an EXIF orientation - so where each colour lands shows
 * exactly how the image was turned.
 */
export async function makeQuadrantJpeg(orientation = 1, width = 120, height = 80) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const key = y < height / 2 ? (x < width / 2 ? 'R' : 'G') : (x < width / 2 ? 'B' : 'Y');
      raw.set(QUADRANT_COLOURS[key], (y * width + x) * 3);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .withMetadata({ orientation })
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** Name the dominant colour of each quadrant of an encoded image, e.g. "RGBY". */
export async function readQuadrants(image) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (fx, fy) => {
    const i = (Math.floor(fy * info.height) * info.width + Math.floor(fx * info.width)) * 3;
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 200 && g > 200) return 'Y';
    if (r > 200) return 'R';
    if (g > 200) return 'G';
    return b > 200 ? 'B' : '?';
  };
  return {
    width: info.width,
    height: info.height,
    quadrants: [at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)].join(''),
  };
}

/**
 * A PDF that claims to be password-protected. pdf-lib cannot encrypt, but a
 * standard-security dictionary whose user hash does not match the empty
 * password is enough for a reader to ask for one.
 */
export async function makeEncryptedPdf() {
  const { PDFDocument, PDFHexString } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  const { context } = doc;
  context.trailerInfo.Encrypt = context.register(context.obj({
    Filter: 'Standard', V: 1, R: 2, Length: 40, P: -4,
    O: PDFHexString.of('00'.repeat(32)),
    U: PDFHexString.of('11'.repeat(32)),
  }));
  context.trailerInfo.ID = context.obj([
    PDFHexString.of('ab'.repeat(16)), PDFHexString.of('ab'.repeat(16)),
  ]);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** A PDF of blank pages with the given [width, height] sizes, in points. */
export async function makePdf(sizes = [[595.28, 841.89]]) {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (const size of sizes) doc.addPage(size);
  return Buffer.from(await doc.save());
}
