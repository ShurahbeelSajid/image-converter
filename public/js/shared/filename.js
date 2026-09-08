/**
 * Output-name construction.
 *
 * Input names reach us from a file picker, a drag-and-drop payload or an HTTP
 * header, so they are untrusted strings. They end up as ZIP entry names and as
 * `Content-Disposition` values, which makes path traversal ("../../.ssh/id_rsa")
 * and CRLF injection real concerns rather than theoretical ones.
 */

import { extOf } from './output-formats.js';

/** Windows device names that cannot be used as a file name, even with a suffix. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Bytes, not characters - most filesystems cap the encoded length. */
const MAX_NAME_BYTES = 200;

/** Truncate to a byte budget without splitting a multi-byte character. */
function truncateBytes(text, maxBytes) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const width = encoder.encode(char).length;
    if (used + width > maxBytes) break;
    out += char;
    used += width;
  }
  return out;
}

/**
 * Reduce an arbitrary string to a single safe path segment.
 *
 * Directory separators are dropped rather than escaped, so a traversal attempt
 * degrades into a harmless flat name instead of an error the caller must
 * remember to handle.
 *
 * @param {string} input
 * @param {{fallback?: string}} [options]
 * @returns {string} A non-empty, single-segment name.
 */
export function sanitizeFilename(input, { fallback = 'image' } = {}) {
  let name = String(input ?? '');

  // Keep only the last segment: defeats "../", "..\" and absolute paths.
  name = name.split(/[\\/]/).pop() ?? '';

  name = name
    // Control characters, including the CR/LF that would split a header.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Reserved on Windows and awkward in a Content-Disposition value.
    .replace(/[<>:"|?*]/g, '')
    // Collapse whitespace runs so names stay single-line and tidy.
    .replace(/\s+/g, ' ')
    .trim();

  // A name of only dots ("." / "..") is meaningless as a file.
  if (/^\.+$/.test(name)) name = '';

  // Windows silently strips trailing dots and spaces; do it explicitly so the
  // name we report matches the name that lands on disk.
  name = name.replace(/[. ]+$/, '');

  if (!name) return fallback;

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  if (RESERVED.has(stem.toLowerCase())) return `${fallback}${ext}`;

  const trimmedStem = truncateBytes(stem, MAX_NAME_BYTES) || fallback;
  return `${trimmedStem}${ext}`;
}

/**
 * Sanitised name with its final extension swapped for `extension`.
 * "holiday.JPG" + "webp" -> "holiday.webp"
 * "archive.tar.gz" + "png" -> "archive.tar.png"
 *
 * @param {string} input Untrusted source name.
 * @param {string} extension Target extension, with or without a leading dot.
 */
export function replaceExtension(input, extension, { fallback = 'image' } = {}) {
  const safe = sanitizeFilename(input, { fallback });
  const dot = safe.lastIndexOf('.');
  const stem = (dot > 0 ? safe.slice(0, dot) : safe) || fallback;
  const ext = String(extension ?? '').replace(/^\./, '');
  return ext ? `${stem}.${ext}` : stem;
}

/**
 * Output name for a conversion, derived from the target format.
 * @param {string} input Source file name.
 * @param {string} format An OUTPUT_FORMATS key, e.g. "jpeg" -> "photo.jpg".
 */
export function toOutputName(input, format, options = {}) {
  return replaceExtension(input, extOf(format) ?? format, options);
}

/**
 * Make `name` unique against names already issued, appending " (2)", " (3)"...
 * `taken` is mutated so it can be threaded through a batch loop.
 *
 * @param {string} name
 * @param {Set<string>} taken Lowercased names already used.
 */
export function uniqueName(name, taken) {
  const key = name.toLowerCase();
  if (!taken.has(key)) {
    taken.add(key);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    const candidateKey = candidate.toLowerCase();
    if (!taken.has(candidateKey)) {
      taken.add(candidateKey);
      return candidate;
    }
  }
}

/**
 * RFC 6266 `Content-Disposition` value. The ASCII `filename` is the fallback
 * for old clients; `filename*` carries the real UTF-8 name.
 */
export function contentDisposition(name, disposition = 'attachment') {
  const safe = sanitizeFilename(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
