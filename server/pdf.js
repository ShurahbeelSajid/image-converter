/**
 * PDF engine: images -> PDF with pdf-lib, PDF -> images with pdf.js.
 *
 * Neither direction grows a second image pipeline. Images bound into a PDF are
 * decoded by sharp, and rendered pages are handed to `convertImage` as raw
 * pixels, so output formats, the target-size search and resizing behave
 * exactly as they do for a plain conversion.
 */

import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import {
  concatTransformationMatrix, drawObject, PDFDocument, popGraphicsState, pushGraphicsState,
} from 'pdf-lib';
import sharp from 'sharp';

import {
  INPUT_FORMATS, MAX_BATCH_FILES, MAX_DIMENSION, MAX_FILE_BYTES, MAX_PDF_PAGES,
  MAX_PDF_RENDER_PIXELS, MAX_PIXELS,
} from '../public/js/shared/constants.js';
import { ErrorCode, validateFile } from '../public/js/shared/validation.js';
import { formatBytes } from '../public/js/shared/format.js';
import {
  layoutPage, orientationMatrix, pageImageName, parsePageRange, pdfFileName, POINTS_PER_INCH,
  sniffPdf,
} from '../public/js/shared/pdf.js';
import { convertImage, orientedSize } from './convert.js';

const deflate = promisify(zlib.deflate);

const coded = (message, code, status, cause) =>
  Object.assign(new Error(message), { code, status, ...(cause && { cause }) });

/** Shown as the PDF's producer in every viewer's document properties. */
const PRODUCER = 'Image Forge';

/** Decode a few images at once; libvips already threads inside each one. */
const PREPARE_CONCURRENCY = Math.max(1, Math.min(4, os.availableParallelism?.() ?? 4));

/** Map with at most `limit` calls in flight, keeping results in input order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/* ---------------------------------------------------------- images -> PDF */

/**
 * Split interleaved pixels into colour and alpha planes, which is how PDF
 * wants them: the alpha becomes a separate soft-mask image. A fully opaque
 * alpha channel is dropped rather than embedded as a no-op mask.
 */
function splitAlpha(pixels, channels) {
  const colourChannels = channels - 1;
  const count = pixels.length / channels;
  const colour = Buffer.allocUnsafe(count * colourChannels);
  const alpha = Buffer.allocUnsafe(count);
  let opaque = true;
  for (let i = 0, o = 0; i < count; i += 1) {
    const base = i * channels;
    for (let c = 0; c < colourChannels; c += 1) colour[o++] = pixels[base + c];
    const a = pixels[base + colourChannels];
    alpha[i] = a;
    if (a !== 255) opaque = false;
  }
  return { colour, alpha: opaque ? null : alpha };
}

/**
 * Turn one page of a source image into something ready to embed.
 *
 * JPEGs go in untouched - PDF stores JPEG natively, so re-encoding would only
 * lose quality - and their EXIF rotation is applied as a PDF transform later.
 * Everything else is decoded to raw pixels and deflated, which is lossless;
 * zlib runs natively and off the main thread, several times faster than
 * pdf-lib's own JavaScript PNG path on a photo-sized image.
 */
async function preparePage(image, { format, metadata, page, singlePage }, options, warnings) {
  const label = image.name;
  const passthrough =
    format === 'jpeg' &&
    singlePage &&
    !options.compress &&
    // PDF readers draw a JPEG as plain RGB or grey; CMYK ones are converted.
    (metadata.space === 'srgb' || metadata.space === 'b-w');

  if (passthrough) {
    const { width, height } = orientedSize(metadata);
    return {
      kind: 'jpeg',
      data: image.data,
      width,
      height,
      orientation: metadata.orientation ?? 1,
      density: metadata.density ?? null,
    };
  }

  let pipeline = sharp(image.data, {
    failOn: 'error',
    page,
    limitInputPixels: MAX_PIXELS,
  }).rotate();

  if (options.compress) {
    if (metadata.hasAlpha) {
      pipeline = pipeline.flatten({ background: options.background });
      warnings.push(`${label}: JPEG has no transparency; composited onto ${options.background}.`);
    }
    const { data, info } = await pipeline
      .jpeg({
        quality: options.quality,
        mozjpeg: true,
        chromaSubsampling: options.quality >= 90 ? '4:4:4' : '4:2:0',
      })
      .toBuffer({ resolveWithObject: true });
    return {
      kind: 'jpeg',
      data,
      width: info.width,
      height: info.height,
      orientation: 1,
      density: metadata.density ?? null,
    };
  }

  const gray = metadata.space === 'b-w' || metadata.channels <= 2;
  const { data: pixels, info } = await pipeline
    .toColourspace(gray ? 'b-w' : 'srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });

  const hasAlpha = info.channels === 2 || info.channels === 4;
  const { colour, alpha } = hasAlpha
    ? splitAlpha(pixels, info.channels)
    : { colour: pixels, alpha: null };

  return {
    kind: 'raw',
    colour: await deflate(colour),
    alpha: alpha ? await deflate(alpha) : null,
    gray,
    width: info.width,
    height: info.height,
    orientation: 1,
    density: metadata.density ?? null,
  };
}

/**
 * Validate and decode one input, returning a prepared entry per PDF page it
 * contributes. A multi-page TIFF is a scanned document, so each of its pages
 * becomes a PDF page; the frames of an animated GIF or WebP are not pages, so
 * those contribute their first frame.
 */
async function prepareImage(image, options, warnings) {
  const label = image.name;
  const verdict = validateFile({ name: image.name, size: image.data.length }, image.data);
  if (!verdict.valid) {
    throw coded(`${label}: ${verdict.errors[0].message}`, verdict.errors[0].code, 415);
  }
  for (const warning of verdict.warnings) warnings.push(`${label}: ${warning}`);

  const format = verdict.detected.format;
  if (INPUT_FORMATS[format]?.serverDecodable === false) {
    throw coded(
      `${label}: ${format.toUpperCase()} cannot be read by the server engine; convert it to PNG first.`,
      'SERVER_CANNOT_DECODE',
      415,
    );
  }

  let metadata;
  try {
    metadata = await sharp(image.data, { failOn: 'error' }).metadata();
  } catch (cause) {
    throw coded(
      `${label}: the image could not be decoded - it may be corrupt or truncated.`,
      'DECODE_FAILED',
      422,
      cause,
    );
  }

  const frames = metadata.pages ?? 1;
  const pageCount = format === 'tiff' ? frames : 1;
  if (format !== 'tiff' && frames > 1) {
    warnings.push(`${label}: animated, so only the first frame was used.`);
  }
  if (pageCount > MAX_PDF_PAGES) {
    throw coded(
      `${label} has ${pageCount} pages - a PDF here holds at most ${MAX_PDF_PAGES}.`,
      ErrorCode.TOO_MANY_PAGES,
      413,
    );
  }

  const pages = [];
  try {
    for (let page = 0; page < pageCount; page += 1) {
      pages.push(await preparePage(
        image,
        { format, metadata, page, singlePage: pageCount === 1 },
        options,
        warnings,
      ));
    }
  } catch (cause) {
    throw coded(`${label}: could not be prepared for the PDF.`, 'ENCODE_FAILED', 422, cause);
  }
  return pages;
}

/** Register a prepared raw image (and its soft mask) as PDF image objects. */
function embedRaw(doc, prepared) {
  const base = {
    Type: 'XObject',
    Subtype: 'Image',
    Width: prepared.width,
    Height: prepared.height,
    BitsPerComponent: 8,
    Filter: 'FlateDecode',
  };
  const smask = prepared.alpha
    ? doc.context.register(doc.context.stream(prepared.alpha, { ...base, ColorSpace: 'DeviceGray' }))
    : null;
  return doc.context.register(doc.context.stream(prepared.colour, {
    ...base,
    ColorSpace: prepared.gray ? 'DeviceGray' : 'DeviceRGB',
    ...(smask && { SMask: smask }),
  }));
}

/**
 * Bind images into one PDF, one page per image (or per TIFF page), in order.
 *
 * @param {Array<{name: string, data: Buffer}>} images
 * @param {object} options Normalised options from `normalisePdfOptions`.
 * @returns {Promise<{data: Buffer, info: object}>}
 */
export async function imagesToPdf(images, options) {
  const startedAt = performance.now();
  const warnings = [];

  if (!Array.isArray(images) || images.length === 0) {
    throw coded('Add at least one image.', ErrorCode.EMPTY_FILE, 400);
  }
  if (images.length > MAX_BATCH_FILES) {
    throw coded(
      `${images.length} images - a PDF can be built from up to ${MAX_BATCH_FILES} at a time.`,
      ErrorCode.BATCH_TOO_LARGE,
      413,
    );
  }

  const prepared = (
    await mapLimit(images, PREPARE_CONCURRENCY, (image) => prepareImage(image, options, warnings))
  ).flat();
  if (prepared.length > MAX_PDF_PAGES) {
    throw coded(
      `Those images make ${prepared.length} pages - a PDF here holds at most ${MAX_PDF_PAGES}.`,
      ErrorCode.TOO_MANY_PAGES,
      413,
    );
  }

  const doc = await PDFDocument.create();
  const name = pdfFileName(images[0].name, options.title);
  doc.setTitle(options.title ?? name.replace(/\.pdf$/, ''));
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);

  for (const entry of prepared) {
    const ref = entry.kind === 'jpeg' ? (await doc.embedJpg(entry.data)).ref : embedRaw(doc, entry);
    const box = layoutPage(entry.width, entry.height, options, entry.density);
    const page = doc.addPage([box.pageWidth, box.pageHeight]);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(...orientationMatrix(entry.orientation, box)),
      drawObject(page.node.newXObject('Image', ref)),
      popGraphicsState(),
    );
  }

  const data = Buffer.from(await doc.save({ useObjectStreams: true }));
  return {
    data,
    info: {
      name,
      pages: prepared.length,
      images: images.length,
      sourceBytes: images.reduce((sum, image) => sum + image.data.length, 0),
      bytes: data.length,
      warnings,
      ms: Math.round(performance.now() - startedAt),
    },
  };
}

/* ---------------------------------------------------------- PDF -> images */

let pdfjsLoading = null;

/**
 * pdf.js is several MB of JavaScript plus a native canvas, so it is loaded on
 * first use: image-only work never pays for it, and a machine without the
 * canvas binary still converts images.
 */
function loadPdfjs() {
  pdfjsLoading ??= (async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    // In Node these are read with fs.readFile, so they are directory paths
    // rather than URLs. pdf.js insists on a trailing "/" - not path.sep - and
    // Windows file APIs accept forward slashes, so use them throughout.
    const dir = (name) => `${path.join(root, name).split(path.sep).join('/')}/`;
    return {
      pdfjs,
      assets: {
        standardFontDataUrl: dir('standard_fonts'),
        cMapUrl: dir('cmaps'),
        iccUrl: dir('iccs'),
        wasmUrl: dir('wasm'),
      },
    };
  })();
  return pdfjsLoading;
}

/** Can this machine render PDF pages? False when the native canvas is missing. */
export async function pdfRenderingAvailable() {
  try {
    await loadPdfjs();
    createRequire(import.meta.url)('@napi-rs/canvas').createCanvas(1, 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scale and canvas size for a page at `dpi`, reduced when the result would
 * exceed the pixel budget. Returns the effective DPI so the caller can say so.
 */
function fitRenderScale(page, dpi) {
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / POINTS_PER_INCH;
  const shrink = Math.min(
    1,
    MAX_DIMENSION / (base.width * scale),
    MAX_DIMENSION / (base.height * scale),
    Math.sqrt(MAX_PDF_RENDER_PIXELS / (base.width * scale * base.height * scale)),
  );
  scale *= shrink;
  const reduced = shrink < 1;
  // A reduced page sits right at the budget, where rounding up a fraction of
  // a pixel would break it, so its canvas rounds down.
  const size = (points) => Math.max(1, (reduced ? Math.floor : Math.round)(points * scale));
  return {
    scale,
    width: size(base.width),
    height: size(base.height),
    dpi: Math.floor(scale * POINTS_PER_INCH),
    reduced,
  };
}

/** Open a PDF with pdf.js, mapping its failures onto the API's error codes. */
async function openPdf(input) {
  const { pdfjs, assets } = await loadPdfjs();
  const task = pdfjs.getDocument({
    // pdf.js takes ownership of - and detaches - the buffer it is given, so it
    // must never be the caller's own Buffer (or Node's shared pool).
    data: new Uint8Array(input),
    ...assets,
    // Fonts are parsed without `eval`, closing off the class of bug behind
    // CVE-2024-4367 rather than relying on the version alone.
    isEvalSupported: false,
    enableXfa: false,
    // A decompression bomb inside the PDF is skipped instead of decoded.
    maxImageSize: MAX_PIXELS,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });

  try {
    return { task, doc: await task.promise };
  } catch (cause) {
    await task.destroy().catch(() => {});
    if (cause?.name === 'PasswordException') {
      throw coded(
        'This PDF is password-protected. Remove the password, then try again.',
        ErrorCode.PDF_ENCRYPTED,
        422,
        cause,
      );
    }
    throw coded(
      'The PDF could not be read - it may be corrupt or truncated.',
      'DECODE_FAILED',
      422,
      cause,
    );
  }
}

/**
 * Render one page to raw RGB pixels on `background`.
 *
 * The canvas is released before returning, so a long document holds one page
 * of pixels at a time rather than one per page.
 */
async function renderPage(doc, page, { scale, width, height }, background) {
  const viewport = page.getViewport({ scale });
  const target = doc.canvasFactory.create(width, height);
  try {
    await page.render({
      canvas: target.canvas,
      canvasContext: target.context,
      viewport,
      background,
    }).promise;
    const { data } = target.context.getImageData(0, 0, width, height);
    // The page is painted onto an opaque background, so alpha is always 255;
    // dropping it keeps encoders from treating the page as transparent.
    const rgb = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels: 4 },
    }).removeAlpha().raw().toBuffer();
    return { rgb, width, height };
  } finally {
    doc.canvasFactory.destroy(target);
    page.cleanup();
  }
}

/**
 * Render pages of a PDF as images in any output format.
 *
 * Pages are rendered one after another to bound memory; each is encoded by
 * the regular image pipeline, so `options` takes everything `convertImage`
 * does, plus `dpi` and a `pages` selection.
 *
 * @param {Buffer} input The complete PDF.
 * @param {object} options Normalised options from `normalisePdfRenderOptions`.
 * @param {{name?: string}} [meta]
 * @returns {Promise<{pages: Array<{page: number, name: string, data: Buffer,
 *                    info: object}>, info: object}>}
 */
export async function pdfToImages(input, options, meta = {}) {
  const startedAt = performance.now();
  const warnings = [];
  const pdfName = meta.name ?? 'document.pdf';

  if (!input?.length) throw coded('File is empty.', ErrorCode.EMPTY_FILE, 400);
  if (input.length > MAX_FILE_BYTES) {
    throw coded(
      `File is ${formatBytes(input.length)} - the limit is ${formatBytes(MAX_FILE_BYTES)}.`,
      ErrorCode.TOO_LARGE,
      413,
    );
  }
  if (!sniffPdf(input.subarray(0, 1024)).isPdf) {
    throw coded('Not a PDF file.', ErrorCode.UNSUPPORTED_TYPE, 415);
  }

  const { task, doc } = await openPdf(input);
  try {
    const selection = parsePageRange(options.pages, doc.numPages);
    if (selection.error) throw coded(selection.error, ErrorCode.INVALID_OPTION, 400);
    if (selection.pages.length > MAX_PDF_PAGES) {
      throw coded(
        `That is ${selection.pages.length} pages - render at most ${MAX_PDF_PAGES} at a time, ` +
        `e.g. with a page range like 1-${MAX_PDF_PAGES}.`,
        ErrorCode.TOO_MANY_PAGES,
        413,
      );
    }

    const rendered = [];
    for (const number of selection.pages) {
      const page = await doc.getPage(number);
      const fit = fitRenderScale(page, options.dpi);
      if (fit.reduced) {
        warnings.push(`Page ${number} is very large, so it was rendered at ${fit.dpi} DPI.`);
      }

      let pixels;
      try {
        pixels = await renderPage(doc, page, fit, options.background);
      } catch (cause) {
        throw coded(`Page ${number} could not be rendered.`, 'RENDER_FAILED', 422, cause);
      }

      const name = pageImageName(pdfName, number, doc.numPages, options.format);
      const { data, info } = await convertImage(pixels.rgb, options, {
        name,
        raw: { width: pixels.width, height: pixels.height, channels: 3 },
        sourceFormat: 'pdf',
      });
      for (const warning of info.warnings) warnings.push(`Page ${number}: ${warning}`);
      rendered.push({ page: number, name, data, info: { ...info, page: number, dpi: fit.dpi } });
    }

    return {
      pages: rendered,
      info: {
        pageCount: doc.numPages,
        rendered: rendered.length,
        format: options.format,
        dpi: options.dpi,
        sourceBytes: input.length,
        bytes: rendered.reduce((sum, page) => sum + page.data.length, 0),
        // Deduplicated: a target-size miss on every page is one message.
        warnings: [...new Set(warnings)],
        ms: Math.round(performance.now() - startedAt),
      },
    };
  } finally {
    await task.destroy();
  }
}

/** Version strings for the health endpoint. */
export async function pdfEngineVersions() {
  const { pdfjs } = await loadPdfjs().catch(() => ({ pdfjs: null }));
  const require = createRequire(import.meta.url);
  const version = (name) => {
    try {
      return require(`${name}/package.json`).version;
    } catch {
      return null;
    }
  };
  return { pdfjs: pdfjs?.version ?? null, pdfLib: version('pdf-lib') };
}
