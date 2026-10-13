/**
 * Browser side of the PDF tools: thin wrappers over the server routes.
 *
 * Unlike image conversion there is no local path - building and rendering
 * PDFs needs pdf-lib and pdf.js, which run in the server engine. The one piece
 * of local work is the BMP bridge, for the same reason converter.js has one.
 */

import { readZip } from './shared/zip.js';
import { replaceExtension } from './shared/filename.js';
import { convertLocally, supportsLocalEncoding } from './converter.js';

/** Turn a non-2xx response into an Error carrying the server's code. */
async function failure(response) {
  const detail = await response.json().catch(() => null);
  const error = new Error(detail?.error ?? `Server returned ${response.status}.`);
  error.code = detail?.code ?? 'SERVER_ERROR';
  return error;
}

function readMeta(response) {
  try {
    return JSON.parse(response.headers.get('x-pdf-meta') ?? '{}');
  } catch {
    return {};
  }
}

/** Query string from an options object, skipping unset values. */
function toQuery(options) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  return params;
}

/**
 * Browsers read BMP and libvips does not, so a BMP is decoded here into a
 * lossless PNG before it is sent - no quality is lost in the hand-off.
 */
async function uploadable({ file, format }) {
  if (format !== 'bmp') return file;
  if (!supportsLocalEncoding()) {
    const error = new Error(`${file.name}: BMP needs decoding in the browser, and this one cannot.`);
    error.code = 'LOCAL_UNSUPPORTED';
    throw error;
  }
  const bridge = await convertLocally(file, {
    format: 'png', quality: 100, lossless: true, background: '#ffffff',
    targetBytes: null, maxWidth: null, maxHeight: null,
  });
  return new File([bridge.bytes], replaceExtension(file.name, 'png'), { type: 'image/png' });
}

/**
 * Bind images into one PDF, in the order given.
 *
 * @param {Array<{file: File, format: string}>} images Files with the format
 *   sniffed from their bytes.
 * @param {object} options Normalised options from `normalisePdfOptions`.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{bytes: Uint8Array, meta: object}>}
 */
export async function imagesToPdf(images, options, signal) {
  const form = new FormData();
  for (const image of images) {
    const file = await uploadable(image);
    form.append('file', file, file.name);
  }

  const query = toQuery({
    pageSize: options.pageSize,
    orientation: options.orientation,
    margin: options.marginMm,
    compress: options.compress,
    quality: options.quality,
    background: options.background,
    title: options.title,
  });
  const response = await fetch(`/api/images-to-pdf?${query}`, { method: 'POST', body: form, signal });
  if (!response.ok) throw await failure(response);
  return { bytes: new Uint8Array(await response.arrayBuffer()), meta: readMeta(response) };
}

/**
 * Render a PDF's pages as images.
 *
 * The server answers with a ZIP of the pages, which is unpacked here; the
 * per-page sizes ride along in the metadata header.
 *
 * @param {File} file
 * @param {object} options Normalised options from `normalisePdfRenderOptions`.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{pages: Array<{page: number, name: string, bytes: Uint8Array,
 *                    width: number|null, height: number|null}>, meta: object}>}
 */
export async function pdfToImages(file, options, signal) {
  const query = toQuery({
    format: options.format,
    quality: options.quality,
    dpi: options.dpi,
    pages: options.pages,
    background: options.background,
    lossless: options.lossless || null,
    targetBytes: options.targetBytes,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
  });
  const response = await fetch(`/api/pdf-to-images?${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/pdf',
      'x-filename': encodeURIComponent(file.name),
    },
    body: file,
    signal,
  });
  if (!response.ok) throw await failure(response);

  const meta = readMeta(response);
  const sizes = new Map((meta.pages ?? []).map((page) => [page.name, page]));
  const pages = readZip(await response.arrayBuffer()).map((entry, index) => {
    const info = sizes.get(entry.name);
    return {
      page: info?.page ?? index + 1,
      name: entry.name,
      bytes: entry.data,
      width: info?.width ?? null,
      height: info?.height ?? null,
    };
  });
  return { pages, meta };
}
