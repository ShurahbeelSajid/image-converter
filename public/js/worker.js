/**
 * Encoding worker: decode -> optional downscale -> flatten -> encode.
 *
 * Runs entirely off the main thread, so a 40-megapixel batch never drops a
 * frame in the UI. One worker handles one image at a time; the pool in
 * converter.js runs several in parallel across CPU cores.
 */

import { SNIFF_BYTES, sniffImage } from './shared/signature.js';
import { validateFile, fitWithin } from './shared/validation.js';
import {
  mimeOf, needsFlattening, OUTPUT_FORMATS, qualityApplies, resolveOutputFormat,
  sourceMayHaveAlpha,
} from './shared/output-formats.js';
import { encodeToTargetSize, SEARCH_MIN_QUALITY } from './shared/compress.js';

const coded = (message, code) => Object.assign(new Error(message), { code });

async function encode(file, options) {
  const startedAt = performance.now();
  const warnings = [];

  // Validate from the real bytes before handing anything to a decoder.
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const verdict = validateFile(file, head);
  if (!verdict.valid) {
    throw coded(verdict.errors[0].message, verdict.errors[0].code);
  }
  warnings.push(...verdict.warnings);

  const sourceFormat = verdict.detected?.format ?? null;
  const resolved = resolveOutputFormat(options.format, sourceFormat);
  const format = resolved.format;
  const spec = OUTPUT_FORMATS[format];

  // Canvas cannot write AVIF, GIF or TIFF at all. Fail with a code the caller
  // recognises so it can retry on the server rather than dead-ending.
  if (!spec.canvasEncodable) {
    throw coded(
      `${spec.label} encoding needs the server engine.`,
      'FORMAT_NEEDS_SERVER',
    );
  }
  // A lossy request that this format cannot honour in a browser - PNG is the
  // real case, where only sharp can quantise to a palette. Hand it over when a
  // server is standing by; otherwise carry on and warn further down, so
  // browser-only mode still returns an image rather than an error.
  const wantsLossy = Boolean(options.targetBytes) || options.quality < 100;
  if (
    wantsLossy &&
    !qualityApplies(format, { engine: 'browser' }) &&
    options.serverFallbackAvailable
  ) {
    throw coded(`${spec.label} compression needs the server engine.`, 'FORMAT_NEEDS_SERVER');
  }

  if (resolved.fellBack) {
    warnings.push(
      `${String(sourceFormat).toUpperCase()} cannot be written back; saved as PNG instead.`,
    );
  }

  let bitmap;
  try {
    // `from-image` applies EXIF orientation, so phone photos are not sideways.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (cause) {
    throw Object.assign(
      coded('This browser could not decode the image. Try the server engine.', 'DECODE_FAILED'),
      { cause },
    );
  }

  try {
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    const target =
      fitWithin(sourceWidth, sourceHeight, options.maxWidth, options.maxHeight) ??
      { width: sourceWidth, height: sourceHeight };

    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext('2d', { alpha: spec.alpha, willReadFrequently: false });
    if (!ctx) throw new Error('Could not acquire a 2D context.');

    // A format with no alpha channel needs transparency composited away first;
    // canvas would otherwise hand the encoder premultiplied black.
    if (needsFlattening(format)) {
      ctx.fillStyle = options.background;
      ctx.fillRect(0, 0, target.width, target.height);
      // Only worth reporting if the source could have had transparency to lose.
      if (sourceMayHaveAlpha(sourceFormat)) {
        warnings.push(
          `${spec.label} has no transparency; composited onto ${options.background}.`,
        );
      }
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);

    const mime = mimeOf(format);
    const lossyHere = qualityApplies(format, { engine: 'browser' });

    const encodeAt = async (quality) => {
      const blob = await canvas.convertToBlob({
        type: mime,
        // Canvas takes 0-1; the UI and the server API both speak 1-100.
        // PNG ignores it entirely.
        ...(lossyHere ? { quality: quality / 100 } : {}),
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { bytes, size: bytes.length };
    };

    let attempt;
    let search = null;
    if (options.targetBytes && lossyHere && !options.lossless) {
      search = await encodeToTargetSize(encodeAt, {
        targetBytes: options.targetBytes,
        minQuality: SEARCH_MIN_QUALITY,
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
          `A target size needs a lossy encoder; ${spec.label} in the browser is lossless, so it was ignored.`,
        );
      }
      attempt = await encodeAt(options.quality);
    }

    const { bytes } = attempt;
    // Engines silently substitute PNG when they cannot encode the requested
    // type, so confirm we got what we asked for rather than trusting the call.
    const produced = sniffImage(bytes).format;
    if (produced !== format) {
      throw coded(
        `This browser cannot encode ${spec.label}. Switch to the server engine.`,
        'FORMAT_NEEDS_SERVER',
      );
    }

    if (options.lossless && lossyHere) {
      warnings.push(
        `Browser encoding has no lossless mode; encoded at maximum quality. Use the server engine for true lossless.`,
      );
    }

    return {
      bytes,
      format,
      sourceFormat,
      keptSource: resolved.keptSource,
      width: target.width,
      height: target.height,
      sourceWidth,
      sourceHeight,
      resized: target.width !== sourceWidth || target.height !== sourceHeight,
      quality: search ? search.quality : options.quality,
      searchAttempts: search ? search.attempts : 0,
      hitTarget: search ? search.hitTarget : null,
      warnings,
      ms: performance.now() - startedAt,
    };
  } finally {
    // Free the decoded surface promptly - a batch of large images will
    // otherwise hold hundreds of MB until GC gets around to it.
    bitmap.close();
  }
}

self.addEventListener('message', async (event) => {
  const { id, file, options } = event.data;
  try {
    const result = await encode(file, options);
    // Transfer the pixel buffer instead of copying it back to the main thread.
    self.postMessage({ id, ok: true, result }, [result.bytes.buffer]);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: { message: error?.message ?? 'Conversion failed.', code: error?.code ?? 'UNKNOWN' },
    });
  }
});
