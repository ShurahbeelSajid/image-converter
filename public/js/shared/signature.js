/**
 * Content-based image identification.
 *
 * A file's extension and its browser-reported MIME type are both attacker- and
 * accident-controlled, so neither is trusted for a routing decision. Everything
 * here reads the actual bytes.
 *
 * Dimensions are parsed straight from the container headers, which lets a
 * caller reject a 60000x60000 "pixel bomb" using only the first few hundred
 * bytes - before a decoder is ever handed the file.
 */

/** Minimum bytes needed for a confident verdict on every supported format. */
export const SNIFF_BYTES = 4096;

const ascii = (bytes, offset, text) => {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

const starts = (bytes, ...expected) => {
  if (bytes.length < expected.length) return false;
  return expected.every((byte, i) => bytes[i] === byte);
};

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** ISO-BMFF brands that carry a still image we can decode. */
const ISOBMFF_BRANDS = new Map([
  ['avif', 'avif'], ['avis', 'avif'],
  ['heic', 'heic'], ['heix', 'heic'], ['hevc', 'heic'], ['hevx', 'heic'],
  ['mif1', 'heic'], ['msf1', 'heic'], ['heim', 'heic'], ['heis', 'heic'],
]);

/**
 * JPEG stores width/height in a Start-Of-Frame segment that can sit anywhere
 * after the EXIF/ICC blocks, so the marker chain has to be walked.
 */
function jpegDimensions(b) {
  let offset = 2; // skip SOI
  while (offset + 3 < b.length) {
    if (b[offset] !== 0xff) {
      offset += 1; // resync across padding
      continue;
    }
    const marker = b[offset + 1];
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
    const length = u16be(b, offset + 2);
    if (length < 2) break;
    const isSOF =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSOF && offset + 9 < b.length) {
      return { width: u16be(b, offset + 7), height: u16be(b, offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

function pngDimensions(b) {
  // 8-byte signature, then the IHDR chunk: length(4) type(4) width(4) height(4)
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function webpDimensions(b) {
  if (b.length < 30) return null;
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (chunk === 'VP8X') {
    // 24-bit little-endian, each stored as (value - 1).
    return {
      width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
      height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
    };
  }
  if (chunk === 'VP8 ') {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function tiffDimensions(b) {
  const little = b[0] === 0x49;
  const u16 = (o) => (little ? u16le(b, o) : u16be(b, o));
  const u32 = (o) => (little ? u32le(b, o) : u32be(b, o));
  const ifd = u32(4);
  if (ifd + 2 > b.length) return null;
  const entries = u16(ifd);
  let width = 0;
  let height = 0;
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > b.length) break;
    const tag = u16(entry);
    // Tag 256 = ImageWidth, 257 = ImageLength; value is SHORT (3) or LONG (4).
    if (tag === 256 || tag === 257) {
      const fieldType = u16(entry + 2);
      const value = fieldType === 3 ? u16(entry + 8) : u32(entry + 8);
      if (tag === 256) width = value;
      else height = value;
    }
  }
  return width && height ? { width, height } : null;
}

/**
 * Identify an image from its leading bytes.
 *
 * @param {Uint8Array|ArrayBuffer} input First {@link SNIFF_BYTES} of the file.
 * @returns {{format: string|null, mime: string|null, width: number|null,
 *            height: number|null, supported: boolean, reason?: string}}
 */
export function sniffImage(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const miss = { format: null, mime: null, width: null, height: null, supported: false };
  const unknownSize = { width: null, height: null };

  if (b.length < 4) return { ...miss, reason: 'File is too small to be an image.' };

  if (starts(b, 0xff, 0xd8, 0xff)) {
    return { format: 'jpeg', mime: 'image/jpeg', supported: true, ...unknownSize, ...jpegDimensions(b) };
  }
  if (starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return { format: 'png', mime: 'image/png', supported: true, ...unknownSize, ...pngDimensions(b) };
  }
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) {
    return { format: 'gif', mime: 'image/gif', supported: true, width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    return { format: 'webp', mime: 'image/webp', supported: true, ...unknownSize, ...webpDimensions(b) };
  }
  if (ascii(b, 0, 'BM')) {
    // BITMAPINFOHEADER dimensions are signed; height is negative for a
    // top-down bitmap, so only the magnitude is meaningful here.
    const sized = b.length >= 26
      ? { width: Math.abs(u32le(b, 18) | 0), height: Math.abs(u32le(b, 22) | 0) }
      : unknownSize;
    return { format: 'bmp', mime: 'image/bmp', supported: true, ...sized };
  }
  if (starts(b, 0x49, 0x49, 0x2a, 0x00) || starts(b, 0x4d, 0x4d, 0x00, 0x2a)) {
    return { format: 'tiff', mime: 'image/tiff', supported: true, ...unknownSize, ...tiffDimensions(b) };
  }
  if (ascii(b, 4, 'ftyp')) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    const format = ISOBMFF_BRANDS.get(brand);
    if (format) {
      // `ispe` sits deep inside the meta box; dimensions stay unknown and the
      // real decoder enforces the pixel ceiling instead.
      return {
        format,
        mime: format === 'avif' ? 'image/avif' : 'image/heic',
        supported: true,
        ...unknownSize,
      };
    }
    return { ...miss, format: 'isobmff', reason: `Unsupported container brand "${brand}".` };
  }
  if (starts(b, 0x00, 0x00, 0x01, 0x00)) {
    return { ...miss, format: 'ico', reason: 'ICO icon containers are not supported.' };
  }
  if (starts(b, 0x25, 0x50, 0x44, 0x46)) {
    return { ...miss, format: 'pdf', reason: 'PDF is a document format, not an image.' };
  }

  // SVG is text: it may open with whitespace, an XML prolog or comments before
  // the root element, so scan a window rather than testing offset 0. TextDecoder
  // strips a leading UTF-8 BOM for us.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(b.subarray(0, Math.min(b.length, 1024)))
    .trimStart();
  if (/<svg[\s>]/i.test(head)) {
    return { ...miss, format: 'svg', reason: 'SVG is a vector format - export it to PNG first.' };
  }

  return { ...miss, reason: 'Unrecognised file type - not a supported image.' };
}

/** Extension of `name`, lowercased, without the dot. Empty string when absent. */
export function extensionOf(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
