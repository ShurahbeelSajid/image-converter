/**
 * Output format capabilities.
 *
 * Every conversion decision keys off this table: which encoder can produce the
 * format, whether it carries an alpha channel, whether quality means anything.
 * Keeping it declarative is what stops the browser and server paths from
 * disagreeing about, say, whether JPEG needs flattening.
 */

/** Sentinel meaning "encode back to whatever the source was" (compress mode). */
export const KEEP_SOURCE = 'original';

export const OUTPUT_FORMATS = Object.freeze({
  webp: {
    label: 'WebP',
    mime: 'image/webp',
    ext: 'webp',
    alpha: true,
    lossy: true,
    lossless: true,
    animated: true,
    /** Can `canvas.convertToBlob` produce it? */
    canvasEncodable: true,
  },
  jpeg: {
    label: 'JPEG',
    mime: 'image/jpeg',
    ext: 'jpg',
    // No alpha channel: transparency must be flattened onto a background
    // first, or it renders as black.
    alpha: false,
    lossy: true,
    lossless: false,
    animated: false,
    canvasEncodable: true,
  },
  png: {
    label: 'PNG',
    mime: 'image/png',
    ext: 'png',
    alpha: true,
    // Always lossless in a browser; sharp can additionally quantise to a
    // palette, which is lossy but shrinks flat graphics dramatically.
    lossy: false,
    lossless: true,
    animated: false,
    canvasEncodable: true,
  },
  avif: {
    label: 'AVIF',
    mime: 'image/avif',
    ext: 'avif',
    alpha: true,
    lossy: true,
    lossless: true,
    animated: false,
    // Browsers decode AVIF but do not encode it.
    canvasEncodable: false,
  },
  gif: {
    label: 'GIF',
    mime: 'image/gif',
    ext: 'gif',
    alpha: true,
    lossy: false,
    lossless: true,
    animated: true,
    canvasEncodable: false,
  },
  tiff: {
    label: 'TIFF',
    mime: 'image/tiff',
    ext: 'tiff',
    alpha: true,
    lossy: true,
    lossless: true,
    animated: false,
    canvasEncodable: false,
  },
});

export const OUTPUT_FORMAT_NAMES = Object.freeze(Object.keys(OUTPUT_FORMATS));

export const DEFAULT_OUTPUT_FORMAT = 'webp';

/** Formats we can decode but not write; "keep source" falls back for these. */
export const KEEP_SOURCE_FALLBACK = 'png';

export const isOutputFormat = (name) =>
  typeof name === 'string' && Object.hasOwn(OUTPUT_FORMATS, name);

/**
 * Decide the concrete output format for a conversion.
 *
 * @param {string} requested An OUTPUT_FORMATS key, or {@link KEEP_SOURCE}.
 * @param {string|null} sourceFormat Format detected from the source bytes.
 * @returns {{format: string, keptSource: boolean, fellBack: boolean}}
 *   `fellBack` is true when the source format cannot be written (BMP, HEIC)
 *   and a lossless stand-in was chosen instead.
 */
export function resolveOutputFormat(requested, sourceFormat) {
  if (requested !== KEEP_SOURCE && isOutputFormat(requested)) {
    return { format: requested, keptSource: false, fellBack: false };
  }
  if (isOutputFormat(sourceFormat)) {
    return { format: sourceFormat, keptSource: true, fellBack: false };
  }
  // BMP and HEIC decode fine but have no writer here; PNG keeps every pixel.
  return { format: KEEP_SOURCE_FALLBACK, keptSource: true, fellBack: true };
}

/** Does `format` need transparency composited away before encoding? */
export const needsFlattening = (format) => OUTPUT_FORMATS[format]?.alpha === false;

/**
 * Source formats that can carry transparency at all. Used to decide whether
 * flattening is worth mentioning: compositing a JPEG onto a background changes
 * nothing, so saying so is noise.
 */
const ALPHA_CAPABLE_SOURCES = new Set(['png', 'webp', 'avif', 'gif', 'tiff', 'bmp', 'heic']);
export const sourceMayHaveAlpha = (format) => ALPHA_CAPABLE_SOURCES.has(format);

/** Does the quality setting change anything for this encoder path? */
export function qualityApplies(format, { engine = 'server' } = {}) {
  const entry = OUTPUT_FORMATS[format];
  if (!entry) return false;
  // Canvas PNG and GIF are strictly lossless, so quality is inert there.
  if (engine === 'browser') return entry.lossy;
  // sharp can quantise a PNG to a palette, which quality does drive.
  return entry.lossy || format === 'png';
}

/** MIME type for a format key, or null. */
export const mimeOf = (format) => OUTPUT_FORMATS[format]?.mime ?? null;

/** Preferred file extension, without the dot. */
export const extOf = (format) => OUTPUT_FORMATS[format]?.ext ?? null;
