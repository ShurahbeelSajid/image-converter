/**
 * PDF options, page selection and page layout.
 *
 * Pure functions over plain data, shared by the browser, the HTTP API and the
 * CLI exactly as validation.js is. The layout maths in particular is tested
 * here with no PDF library in the loop.
 */

import { PDF_DPI_DEFAULT, PDF_DPI_MAX, PDF_DPI_MIN } from './constants.js';
import { extOf, KEEP_SOURCE } from './output-formats.js';
import { replaceExtension } from './filename.js';
import { clampInt, ErrorCode, normaliseOptions } from './validation.js';

/** PDF measures everything in PostScript points. */
export const POINTS_PER_INCH = 72;
const MM_PER_INCH = 25.4;

/** Acrobat refuses to open pages longer than 200 inches a side. */
export const MAX_PAGE_POINTS = 14_400;

/**
 * Resolution assumed for "fit" pages when an image records none, or records
 * something implausible. 96 is what browsers and img2pdf assume.
 */
export const DEFAULT_IMAGE_DPI = 96;
const PLAUSIBLE_DPI = [36, 2400];

/** Paper sizes in points, portrait. `null` sizes the page to the image. */
export const PAGE_SIZES = Object.freeze({
  fit: { label: 'Fit to image', size: null },
  a4: { label: 'A4', size: [595.28, 841.89] },
  letter: { label: 'US Letter', size: [612, 792] },
  legal: { label: 'US Legal', size: [612, 1008] },
  a3: { label: 'A3', size: [841.89, 1190.55] },
  a5: { label: 'A5', size: [419.53, 595.28] },
});

export const ORIENTATIONS = Object.freeze(['auto', 'portrait', 'landscape']);

/** Caps the margin so even an A5 page keeps a usable image box. */
export const MAX_MARGIN_MM = 50;

const fail = (code, message) => ({ code, message });
const absent = (value) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
const flag = (value) => value === true || value === 'true' || value === '1' || value === 'on';

export const mmToPoints = (mm) => (mm * POINTS_PER_INCH) / MM_PER_INCH;

/**
 * Does `input` look like a PDF? Readers tolerate up to 1 KB of junk before the
 * `%PDF-` header, so this does too.
 *
 * @param {Uint8Array|ArrayBuffer} input Leading bytes of the file.
 * @returns {{isPdf: boolean, version: string|null}}
 */
export function sniffPdf(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const last = Math.min(b.length, 1024) - 5;
  for (let i = 0; i <= last; i += 1) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 &&
        b[i + 4] === 0x2d) {
      const match = /^\d\.\d/.exec(String.fromCharCode(...b.subarray(i + 5, i + 8)));
      return { isPdf: true, version: match ? match[0] : null };
    }
  }
  return { isPdf: false, version: null };
}

/**
 * Parse a page selection such as "1-3, 5, 8-" against a document's length.
 *
 * Blank or "all" selects every page; "-4" means up to page 4 and "8-" means
 * page 8 onwards. Pages come back ascending and de-duplicated, so "3, 1-3"
 * renders each of pages 1-3 once. Ranges are checked against `pageCount`
 * before being expanded, so "1-999999999" is an error, not a long loop.
 *
 * @returns {{pages: number[]|null, error: string|null}}
 */
export function parsePageRange(input, pageCount) {
  const text = String(input ?? '').trim().toLowerCase();
  const every = () => Array.from({ length: pageCount }, (_, i) => i + 1);
  if (text === '' || text === 'all') return { pages: every(), error: null };

  const plural = pageCount === 1 ? 'page' : 'pages';
  const selected = new Set();
  for (const part of text.split(',')) {
    const token = part.trim();
    if (token === '') continue; // tolerate "1,,2" and a trailing comma

    const span = /^(\d*)\s*-\s*(\d*)$/.exec(token);
    if (!/^\d+$/.test(token) && (!span || (span[1] === '' && span[2] === ''))) {
      return { pages: null, error: `"${token}" is not a page number or a range like 2-5.` };
    }
    const from = span ? (span[1] === '' ? 1 : Number(span[1])) : Number(token);
    const to = span ? (span[2] === '' ? pageCount : Number(span[2])) : from;

    if (from < 1 || to < 1) return { pages: null, error: 'Pages are numbered from 1.' };
    if (from > pageCount || to > pageCount) {
      const missing = from > pageCount ? from : to;
      return {
        pages: null,
        error: `Page ${missing} does not exist - the PDF has ${pageCount} ${plural}.`,
      };
    }
    if (from > to) return { pages: null, error: `The range ${token} runs backwards.` };
    for (let page = from; page <= to; page += 1) selected.add(page);
  }

  if (selected.size === 0) return { pages: null, error: 'Select at least one page.' };
  return { pages: [...selected].sort((a, b) => a - b), error: null };
}

/**
 * Page box and image placement for one image-to-PDF page, in points.
 *
 * "Fit" pages take the image's own size at the resolution it records, so a
 * 300 DPI A4 scan comes back as exactly an A4 page. Paper sizes scale the
 * image to fill the area inside the margins - up or down - keeping its aspect
 * ratio, and centre it.
 *
 * @param {number} width Upright image width in pixels (after EXIF rotation).
 * @param {number} height Upright image height in pixels.
 * @param {{pageSize: string, orientation: string, marginMm: number}} options
 * @param {number|null} [dpi] Resolution the image records, if any.
 * @returns {{pageWidth: number, pageHeight: number,
 *            x: number, y: number, width: number, height: number}}
 */
export function layoutPage(width, height, options, dpi = null) {
  const margin = mmToPoints(options.marginMm ?? 0);
  const preset = PAGE_SIZES[options.pageSize]?.size ?? null;

  if (!preset) {
    const resolution = dpi >= PLAUSIBLE_DPI[0] && dpi <= PLAUSIBLE_DPI[1] ? dpi : DEFAULT_IMAGE_DPI;
    let imageWidth = (width * POINTS_PER_INCH) / resolution;
    let imageHeight = (height * POINTS_PER_INCH) / resolution;
    // Shrinking the page only changes the effective DPI; every pixel survives.
    const room = MAX_PAGE_POINTS - 2 * margin;
    const shrink = Math.min(1, room / imageWidth, room / imageHeight);
    imageWidth *= shrink;
    imageHeight *= shrink;
    return {
      pageWidth: imageWidth + 2 * margin,
      pageHeight: imageHeight + 2 * margin,
      x: margin,
      y: margin,
      width: imageWidth,
      height: imageHeight,
    };
  }

  const short = Math.min(...preset);
  const long = Math.max(...preset);
  const landscape =
    options.orientation === 'landscape' || (options.orientation !== 'portrait' && width > height);
  const pageWidth = landscape ? long : short;
  const pageHeight = landscape ? short : long;

  const scale = Math.min((pageWidth - 2 * margin) / width, (pageHeight - 2 * margin) / height);
  const imageWidth = width * scale;
  const imageHeight = height * scale;
  return {
    pageWidth,
    pageHeight,
    x: (pageWidth - imageWidth) / 2,
    y: (pageHeight - imageHeight) / 2,
    width: imageWidth,
    height: imageHeight,
  };
}

/**
 * The PDF transformation matrix [a b c d e f] that draws a stored image upright
 * inside `box`, given its EXIF orientation (1-8).
 *
 * PDF paints an image onto the unit square with its first row at the top, so
 * each orientation is just a different affine map from that square onto the
 * upright box. Doing the rotation here rather than re-encoding is what lets a
 * sideways phone JPEG go into the PDF byte for byte.
 *
 * @param {number} orientation EXIF orientation; anything else counts as 1.
 * @param {{x: number, y: number, width: number, height: number}} box Upright
 *   placement on the page, in points.
 * @returns {number[]}
 */
export function orientationMatrix(orientation, { x, y, width: w, height: h }) {
  switch (orientation) {
    case 2: return [-w, 0, 0, h, x + w, y]; // mirrored
    case 3: return [-w, 0, 0, -h, x + w, y + h]; // upside down
    case 4: return [w, 0, 0, -h, x, y + h]; // flipped vertically
    case 5: return [0, -h, -w, 0, x + w, y + h]; // transposed
    case 6: return [0, -h, w, 0, x, y + h]; // needs 90 degrees clockwise
    case 7: return [0, h, w, 0, x, y]; // transversed
    case 8: return [0, h, -w, 0, x + w, y]; // needs 90 degrees anticlockwise
    default: return [w, 0, 0, h, x, y];
  }
}

/**
 * Normalise images-to-PDF options from any untrusted source, in the same
 * clamp-or-reject spirit as `normaliseOptions`.
 *
 * `compress` re-encodes every image as JPEG at `quality`; without it JPEGs are
 * embedded untouched and everything else losslessly.
 *
 * @returns {{options: object, errors: Array<{code: string, message: string}>}}
 */
export function normalisePdfOptions(raw = {}) {
  const errors = [];

  let pageSize = 'fit';
  if (!absent(raw.pageSize)) {
    const requested = String(raw.pageSize).toLowerCase();
    if (Object.hasOwn(PAGE_SIZES, requested)) pageSize = requested;
    else {
      errors.push(fail(
        ErrorCode.INVALID_OPTION,
        `Unknown page size "${raw.pageSize}" - use ${Object.keys(PAGE_SIZES).join(', ')}.`,
      ));
    }
  }

  let orientation = 'auto';
  if (!absent(raw.orientation)) {
    const requested = String(raw.orientation).toLowerCase();
    if (ORIENTATIONS.includes(requested)) orientation = requested;
    else {
      errors.push(fail(
        ErrorCode.INVALID_OPTION,
        `Unknown orientation "${raw.orientation}" - use ${ORIENTATIONS.join(', ')}.`,
      ));
    }
  }

  let marginMm = 0;
  if (!absent(raw.margin)) {
    const n = Number(raw.margin);
    if (!Number.isFinite(n) || n < 0) {
      errors.push(fail(ErrorCode.INVALID_OPTION, 'margin must be a number of millimetres, 0 or more.'));
    } else {
      marginMm = Math.min(n, MAX_MARGIN_MM);
    }
  }

  // Quality and background share the image converter's parsing, so the two
  // reject the same input with the same message.
  const image = normaliseOptions({ quality: raw.quality, background: raw.background });
  errors.push(...image.errors);

  // Embedded as document metadata: one line, printable, bounded.
  const title = absent(raw.title)
    ? null
    // eslint-disable-next-line no-control-regex
    : String(raw.title).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || null;

  return {
    options: {
      pageSize,
      orientation,
      marginMm,
      compress: flag(raw.compress),
      quality: image.options.quality,
      background: image.options.background,
      title,
    },
    errors,
  };
}

/**
 * Normalise PDF-to-images options: the image converter's options plus a
 * render resolution and a page selection.
 *
 * PNG is the default because it keeps text crisp, and unless a quality is
 * given it stays lossless - sharp would otherwise palette-quantise the page at
 * the converter's default quality.
 *
 * @returns {{options: object, errors: Array<{code: string, message: string}>}}
 */
export function normalisePdfRenderOptions(raw = {}) {
  const format = absent(raw.format) ? 'png' : raw.format;
  const quality = absent(raw.quality) && String(format).toLowerCase() === 'png' ? 100 : raw.quality;
  const { options, errors } = normaliseOptions({ ...raw, format, quality });

  if (options.format === KEEP_SOURCE) {
    errors.push(fail(
      ErrorCode.INVALID_OPTION,
      'Choose an output format for PDF pages - a PDF has no image format to keep.',
    ));
  }

  const pages = absent(raw.pages) ? '' : String(raw.pages).trim().slice(0, 1000);

  return {
    options: {
      ...options,
      dpi: clampInt(raw.dpi, PDF_DPI_MIN, PDF_DPI_MAX, PDF_DPI_DEFAULT),
      pages,
    },
    errors,
  };
}

/**
 * File name for one rendered page: "report.pdf", page 7 of 120, PNG ->
 * "report-page-007.png". Zero-padding to the document's length keeps the
 * pages in order in any file listing.
 */
export function pageImageName(pdfName, page, pageCount, format) {
  const stem = replaceExtension(pdfName, '', { fallback: 'document' });
  const digits = String(Math.max(1, pageCount)).length;
  return `${stem}-page-${String(page).padStart(digits, '0')}.${extOf(format) ?? format}`;
}

/** File name for a built PDF: its title if it has one, else the first image's. */
export function pdfFileName(firstImageName, title = null) {
  // The title gets a throwaway extension so a dot inside it survives the swap.
  const base = title ? `${title}.pdf` : (firstImageName ?? 'images');
  return replaceExtension(base, 'pdf', { fallback: 'images' });
}
