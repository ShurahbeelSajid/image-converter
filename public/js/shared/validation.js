/**
 * Validation rules shared by the browser, the HTTP API and the CLI.
 *
 * Every rule is a pure function over plain data so the exact code path the UI
 * takes is the one the test suite exercises. Nothing here touches the DOM,
 * the filesystem or the network.
 */

import {
  DEFAULT_BACKGROUND,
  EFFORT_DEFAULT,
  EFFORT_MAX,
  EFFORT_MIN,
  INPUT_FORMATS,
  MAX_BATCH_FILES,
  MAX_DIMENSION,
  MAX_FILE_BYTES,
  MAX_PIXELS,
  MIN_TARGET_BYTES,
  QUALITY_DEFAULT,
  QUALITY_MAX,
  QUALITY_MIN,
} from './constants.js';
import { DEFAULT_OUTPUT_FORMAT, isOutputFormat, KEEP_SOURCE } from './output-formats.js';
import { parseTargetSize } from './compress.js';
import { extensionOf, sniffImage } from './signature.js';
import { formatBytes } from './format.js';

/** Stable machine-readable codes so the UI can branch without string matching. */
export const ErrorCode = Object.freeze({
  EMPTY_FILE: 'EMPTY_FILE',
  TOO_LARGE: 'TOO_LARGE',
  UNREADABLE: 'UNREADABLE',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  DIMENSIONS_TOO_LARGE: 'DIMENSIONS_TOO_LARGE',
  TOO_MANY_PIXELS: 'TOO_MANY_PIXELS',
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  INVALID_OPTION: 'INVALID_OPTION',
});

const fail = (code, message) => ({ code, message });

/**
 * Validate one candidate file.
 *
 * `bytes` should hold at least the first `SNIFF_BYTES` of the file; the whole
 * buffer is accepted too. Pass `null` to run only the metadata checks (useful
 * for a fast pre-filter before reading anything off disk).
 *
 * @param {{name?: string, size: number, type?: string}} file
 * @param {Uint8Array|null} bytes Leading bytes of the file, or null.
 * @param {{maxBytes?: number}} [limits]
 * @returns {{valid: boolean, errors: Array<{code: string, message: string}>,
 *            warnings: string[], detected: object|null}}
 */
export function validateFile(file, bytes = null, limits = {}) {
  const maxBytes = limits.maxBytes ?? MAX_FILE_BYTES;
  const errors = [];
  const warnings = [];
  const name = String(file?.name ?? 'image');
  const size = Number(file?.size);

  if (!Number.isFinite(size) || size <= 0) {
    errors.push(fail(ErrorCode.EMPTY_FILE, 'File is empty.'));
    return { valid: false, errors, warnings, detected: null };
  }
  if (size > maxBytes) {
    errors.push(
      fail(
        ErrorCode.TOO_LARGE,
        `File is ${formatBytes(size)} - the limit is ${formatBytes(maxBytes)}.`,
      ),
    );
    return { valid: false, errors, warnings, detected: null };
  }

  if (!bytes) return { valid: true, errors, warnings, detected: null };

  const detected = sniffImage(bytes);
  if (!detected.supported) {
    errors.push(
      fail(
        ErrorCode.UNSUPPORTED_TYPE,
        detected.reason ?? 'Unrecognised file type - not a supported image.',
      ),
    );
    return { valid: false, errors, warnings, detected };
  }

  const { width, height } = detected;
  if (width && height) {
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      errors.push(
        fail(
          ErrorCode.DIMENSIONS_TOO_LARGE,
          `Image is ${width}x${height}px - each side must be at most ${MAX_DIMENSION}px.`,
        ),
      );
    } else if (width * height > MAX_PIXELS) {
      errors.push(
        fail(
          ErrorCode.TOO_MANY_PIXELS,
          `Image has ${(width * height / 1e6).toFixed(1)} megapixels - the limit is ${MAX_PIXELS / 1e6}MP.`,
        ),
      );
    }
  }

  // The extension is advisory only: the bytes already decided the format, so a
  // mismatch is surfaced as a note rather than blocking a perfectly good image.
  const ext = extensionOf(name);
  const expected = INPUT_FORMATS[detected.format]?.ext ?? [];
  if (ext && expected.length && !expected.includes(ext)) {
    warnings.push(`Named .${ext} but the contents are ${detected.format.toUpperCase()}.`);
  }

  return { valid: errors.length === 0, errors, warnings, detected };
}

/**
 * Validate a whole batch before any work starts.
 * @param {Array<{size: number}>} files
 */
export function validateBatch(files, limits = {}) {
  const maxFiles = limits.maxFiles ?? MAX_BATCH_FILES;
  const errors = [];
  if (!Array.isArray(files) || files.length === 0) {
    errors.push(fail(ErrorCode.EMPTY_FILE, 'Select at least one image.'));
  } else if (files.length > maxFiles) {
    errors.push(
      fail(
        ErrorCode.BATCH_TOO_LARGE,
        `${files.length} files selected - up to ${maxFiles} at a time.`,
      ),
    );
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Clamp `value` into [min, max], falling back to `fallback` when it is absent
 * or unparsable.
 *
 * Absent is checked before coercion on purpose: `Number(null)` and `Number('')`
 * are both 0, which would silently clamp a blank quality field to the minimum
 * and hand back the worst possible image instead of the default.
 */
function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Normalise encoder options from any untrusted source (query string, form
 * control, CLI flag). Out-of-range numbers are clamped rather than rejected so
 * a stray slider value never fails a conversion; genuinely nonsensical input
 * (a negative resize target, an unknown fit) is reported as an error.
 *
 * @returns {{options: object, errors: Array<{code: string, message: string}>}}
 */
export function normaliseOptions(raw = {}) {
  const errors = [];
  const quality = clampInt(raw.quality, QUALITY_MIN, QUALITY_MAX, QUALITY_DEFAULT);
  const effort = clampInt(raw.effort, EFFORT_MIN, EFFORT_MAX, EFFORT_DEFAULT);
  const lossless = raw.lossless === true || raw.lossless === 'true' || raw.lossless === '1';
  const keepMetadata =
    raw.keepMetadata === true || raw.keepMetadata === 'true' || raw.keepMetadata === '1';

  let maxWidth = null;
  let maxHeight = null;
  for (const key of ['maxWidth', 'maxHeight']) {
    const value = raw[key];
    if (value === undefined || value === null || value === '' || value === 'auto') continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(fail(ErrorCode.INVALID_OPTION, `${key} must be a positive number.`));
      continue;
    }
    if (n > MAX_DIMENSION) {
      errors.push(
        fail(ErrorCode.INVALID_OPTION, `${key} must be at most ${MAX_DIMENSION}px.`),
      );
      continue;
    }
    if (key === 'maxWidth') maxWidth = Math.round(n);
    else maxHeight = Math.round(n);
  }

  // Target output format. `KEEP_SOURCE` means "re-encode as whatever came in",
  // which is what compression mode wants.
  let format = DEFAULT_OUTPUT_FORMAT;
  if (raw.format !== undefined && raw.format !== null && raw.format !== '') {
    const requested = String(raw.format).toLowerCase();
    const alias = { jpg: 'jpeg', tif: 'tiff', same: KEEP_SOURCE, auto: KEEP_SOURCE };
    const resolved = alias[requested] ?? requested;
    if (resolved === KEEP_SOURCE || isOutputFormat(resolved)) {
      format = resolved;
    } else {
      errors.push(fail(ErrorCode.INVALID_OPTION, `Unknown output format "${raw.format}".`));
    }
  }

  // Composited under transparency when the target has no alpha channel.
  let background = DEFAULT_BACKGROUND;
  if (raw.background !== undefined && raw.background !== null && raw.background !== '') {
    const value = String(raw.background).trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
      background = value.toLowerCase();
    } else {
      errors.push(
        fail(ErrorCode.INVALID_OPTION, `background must be a hex colour like #ffffff.`),
      );
    }
  }

  // Size budget: when set, quality is searched for rather than dictated.
  let targetBytes = null;
  if (raw.targetBytes !== undefined && raw.targetBytes !== null && raw.targetBytes !== '') {
    const parsed = parseTargetSize(raw.targetBytes);
    if (parsed === null) {
      errors.push(
        fail(ErrorCode.INVALID_OPTION, 'targetBytes must be a size like 200KB or 180000.'),
      );
    } else if (parsed < MIN_TARGET_BYTES) {
      errors.push(
        fail(
          ErrorCode.INVALID_OPTION,
          `Target size must be at least ${formatBytes(MIN_TARGET_BYTES)}.`,
        ),
      );
    } else {
      targetBytes = parsed;
    }
  }

  return {
    options: {
      format,
      quality,
      effort,
      lossless,
      keepMetadata,
      maxWidth,
      maxHeight,
      background,
      targetBytes,
    },
    errors,
  };
}

/**
 * Target dimensions for a "fit inside the box, never upscale" resize.
 * Returns null when the image already fits and should be passed through.
 */
export function fitWithin(width, height, maxWidth, maxHeight) {
  if (!width || !height) return null;
  if (!maxWidth && !maxHeight) return null;
  const scale = Math.min(
    maxWidth ? maxWidth / width : Infinity,
    maxHeight ? maxHeight / height : Infinity,
  );
  if (!Number.isFinite(scale) || scale >= 1) return null; // never upscale
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
