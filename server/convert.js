/**
 * Server-side encoding, backed by sharp/libvips.
 *
 * Handles any supported input format to any supported output format, plus
 * target-size compression. Preferred over the browser engine when the input is
 * a format canvas cannot decode (TIFF, HEIC), the output is one canvas cannot
 * write (AVIF, GIF, TIFF), or the caller wants libwebp's `effort` budget and
 * PNG palette quantisation - none of which the canvas API exposes.
 */

import sharp from 'sharp';

import { INPUT_FORMATS, MAX_PIXELS, PNG_COMPRESSION_LEVEL } from '../public/js/shared/constants.js';
import { validateFile } from '../public/js/shared/validation.js';
import {
  needsFlattening, OUTPUT_FORMATS, qualityApplies, resolveOutputFormat,
} from '../public/js/shared/output-formats.js';
import { encodeToTargetSize, SEARCH_MIN_QUALITY } from '../public/js/shared/compress.js';

// libvips keeps a slab of decoded tiles around for repeated reads of the same
// file. Every request here is a different image, so the cache only costs RSS.
sharp.cache(false);
// Let libvips use every core for a single image; requests queue behind it,
// which keeps peak memory predictable under load.
sharp.concurrency(0);

/** Pixel dimensions as displayed, accounting for an EXIF rotation. */
export function orientedSize(metadata) {
  const swap = (metadata.orientation ?? 1) >= 5;
  return {
    width: swap ? metadata.height : metadata.width,
    height: swap ? metadata.width : metadata.height,
  };
}

/**
 * Attach the encoder for `format`. Each branch is tuned for that codec rather
 * than passing one generic `quality` through and hoping for the best.
 */
function applyEncoder(pipeline, format, options) {
  const { quality, effort, lossless } = options;
  switch (format) {
    case 'webp':
      return pipeline.webp({
        quality,
        effort,
        lossless,
        smartSubsample: true,
        alphaQuality: lossless ? 100 : Math.min(100, quality + 10),
      });
    case 'jpeg':
      return pipeline.jpeg({
        quality,
        // mozjpeg's trellis quantisation is a clear win at equal quality.
        mozjpeg: true,
        progressive: true,
        // Full chroma resolution only where it will actually be noticed.
        chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0',
      });
    case 'png':
      // PNG is lossless by definition, so "quality" drives palette
      // quantisation instead - the same trick pngquant uses. Below 100 that
      // is lossy, which is why it is opt-in via the quality slider.
      return pipeline.png({
        compressionLevel: PNG_COMPRESSION_LEVEL,
        effort: Math.max(1, effort),
        ...(lossless || quality >= 100
          ? { palette: false }
          : { palette: true, quality, dither: 1 }),
      });
    case 'avif':
      return pipeline.avif({
        quality,
        // sharp's AVIF effort runs 0-9; ours is 0-6, so it maps straight in.
        effort,
        lossless,
        chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0',
      });
    case 'gif':
      return pipeline.gif({ effort: Math.min(10, Math.max(1, effort + 1)) });
    case 'tiff':
      // LZW and packbits are byte-oriented run encoders: on photographic data
      // they can inflate a file several times over (measured: 78KB -> 1.1MB).
      // JPEG-in-TIFF is the only option that actually compresses such images,
      // so it is used unless losslessness is required - or unless the image
      // carries alpha, which JPEG cannot represent.
      return options.losslessTiff
        ? pipeline.tiff({ compression: 'deflate', predictor: 'horizontal' })
        : pipeline.tiff({ quality, compression: 'jpeg' });
    default:
      throw Object.assign(new Error(`No encoder for "${format}".`), {
        code: 'UNSUPPORTED_OUTPUT',
        status: 400,
      });
  }
}

/**
 * Convert an encoded image buffer to the requested format.
 *
 * `meta.raw` switches the input to bare pixels - how rendered PDF pages arrive.
 * They skip file validation, since nothing untrusted produced them, and the
 * caller is responsible for having bounded their dimensions.
 *
 * @param {Buffer} input Complete source file, or raw pixels with `meta.raw`.
 * @param {object} options Normalised options from `normaliseOptions`.
 * @param {{name?: string, raw?: {width: number, height: number, channels: number},
 *          sourceFormat?: string}} [meta]
 * @returns {Promise<{data: Buffer, info: object}>}
 */
export async function convertImage(input, options, meta = {}) {
  const startedAt = performance.now();
  const warnings = [];
  const raw = meta.raw ?? null;

  let sourceFormat = meta.sourceFormat ?? null;
  if (raw) {
    if (input.length !== raw.width * raw.height * raw.channels) {
      throw new RangeError('Raw pixel buffer does not match its stated dimensions.');
    }
  } else {
    // Same byte-level validation the browser engine runs, so both paths reject
    // identically instead of drifting apart.
    const verdict = validateFile({ name: meta.name ?? 'upload', size: input.length }, input);
    if (!verdict.valid) {
      const error = new Error(verdict.errors[0].message);
      error.code = verdict.errors[0].code;
      error.status = 415;
      throw error;
    }
    warnings.push(...verdict.warnings);
    sourceFormat = verdict.detected?.format ?? null;
  }

  // libvips has no BMP reader, so say so plainly instead of letting the decode
  // fail with a generic "corrupt file" further down.
  if (INPUT_FORMATS[sourceFormat]?.serverDecodable === false) {
    const error = new Error(
      `${sourceFormat.toUpperCase()} cannot be read by the server engine; convert it in the browser.`,
    );
    error.code = 'SERVER_CANNOT_DECODE';
    error.status = 415;
    throw error;
  }

  const resolved = resolveOutputFormat(options.format, sourceFormat);
  const format = resolved.format;
  if (resolved.fellBack) {
    warnings.push(
      `${String(sourceFormat).toUpperCase()} cannot be written back; saved as PNG instead.`,
    );
  }

  // Animation only survives if both ends support it; otherwise take frame one.
  const sourceAnimated = sourceFormat === 'gif' || sourceFormat === 'webp';
  const keepAnimation = sourceAnimated && OUTPUT_FORMATS[format].animated;

  let metadata;
  try {
    metadata = await sharp(input, {
      failOn: 'error',
      animated: keepAnimation,
      ...(raw && { raw }),
    }).metadata();
  } catch (cause) {
    const error = new Error('The image could not be decoded - it may be corrupt or truncated.');
    error.code = 'DECODE_FAILED';
    error.status = 422;
    error.cause = cause;
    throw error;
  }

  if (sourceAnimated && (metadata.pages ?? 1) > 1 && !OUTPUT_FORMATS[format].animated) {
    warnings.push(`${format.toUpperCase()} cannot animate; kept the first frame only.`);
  }

  const source = orientedSize(metadata);
  const flatten = needsFlattening(format);
  if (flatten && metadata.hasAlpha) {
    warnings.push(
      `${format.toUpperCase()} has no transparency; composited onto ${options.background}.`,
    );
  }

  /**
   * Build the decode/transform half of the pipeline.
   *
   * A fresh instance per attempt keeps the target-size search on exactly the
   * same code path as a single encode - including metadata handling, which a
   * decode-once-to-raw shortcut would silently drop.
   */
  const prepare = () => {
    let pipeline = sharp(input, {
      // Surface truncated files as errors rather than half-decoded output.
      failOn: 'error',
      limitInputPixels: MAX_PIXELS,
      sequentialRead: true,
      animated: keepAnimation,
      ...(raw && { raw }),
    });

    // `.rotate()` with no argument bakes in the EXIF orientation. It must come
    // before `.resize()` so the fit box applies to the upright image.
    pipeline = pipeline.rotate();

    if (options.maxWidth || options.maxHeight) {
      pipeline = pipeline.resize({
        width: options.maxWidth ?? null,
        height: options.maxHeight ?? null,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: 'lanczos3',
      });
    }

    // Composite transparency away before an encoder that cannot store it,
    // otherwise transparent pixels come out black.
    if (flatten) pipeline = pipeline.flatten({ background: options.background });

    if (options.keepMetadata) pipeline = pipeline.keepMetadata();
    return pipeline;
  };

  // JPEG-in-TIFF discards alpha, so a transparent source forces the lossless
  // deflate path even when the caller asked for a lossy quality.
  const losslessTiff = options.lossless || options.quality >= 100 || Boolean(metadata.hasAlpha);
  if (format === 'tiff' && losslessTiff && metadata.hasAlpha && !options.lossless) {
    warnings.push('TIFF kept transparency, so it was written with lossless deflate.');
  }

  const encodeAt = async (quality) => {
    const { data, info } = await applyEncoder(prepare(), format, {
      ...options,
      quality,
      losslessTiff,
    }).toBuffer({ resolveWithObject: true });
    return { data, info, size: data.length };
  };

  let attempt;
  let search = null;
  try {
    if (options.targetBytes && qualityApplies(format, { engine: 'server' }) && !options.lossless) {
      search = await encodeToTargetSize(encodeAt, {
        targetBytes: options.targetBytes,
        minQuality: SEARCH_MIN_QUALITY,
        // Never exceed the quality the caller asked for.
        maxQuality: options.quality,
      });
      attempt = search;
      if (!search.hitTarget) {
        warnings.push(
          `Could not reach the target size even at quality ${SEARCH_MIN_QUALITY}; ` +
          'try resizing the image as well.',
        );
      }
    } else {
      if (options.targetBytes) {
        warnings.push(
          `A target size needs a lossy encoder; ${format.toUpperCase()} here is lossless, so it was ignored.`,
        );
      }
      attempt = await encodeAt(options.quality);
    }
  } catch (cause) {
    if (cause?.code === 'UNSUPPORTED_OUTPUT') throw cause;
    const error = new Error(`${format.toUpperCase()} encoding failed.`);
    error.code = 'ENCODE_FAILED';
    error.status = 500;
    error.cause = cause;
    throw error;
  }

  const { data, info } = attempt;
  return {
    data,
    info: {
      format,
      sourceFormat: raw ? sourceFormat : metadata.format,
      keptSource: resolved.keptSource,
      width: info.width,
      height: info.height,
      sourceWidth: source.width,
      sourceHeight: source.height,
      resized: info.width !== source.width || info.height !== source.height,
      pages: metadata.pages ?? 1,
      sourceBytes: input.length,
      bytes: data.length,
      quality: search ? search.quality : options.quality,
      searchAttempts: search ? search.attempts : 0,
      hitTarget: search ? search.hitTarget : null,
      warnings,
      ms: Math.round(performance.now() - startedAt),
    },
  };
}

/** Version strings for the health endpoint. */
export function engineVersions() {
  return { sharp: sharp.versions.sharp, libvips: sharp.versions.vips };
}
