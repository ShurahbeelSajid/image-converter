/**
 * HTTP entry point.
 *
 * Plain `node:http` rather than a framework: the whole surface is a handful of
 * routes, and skipping the middleware stack keeps per-request overhead near
 * zero on the hot path (a large binary upload).
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_BATCH_UPLOAD_BYTES, MAX_FILE_BYTES } from '../public/js/shared/constants.js';
import { normaliseOptions } from '../public/js/shared/validation.js';
import { contentDisposition, replaceExtension, toOutputName } from '../public/js/shared/filename.js';
import { mimeOf, OUTPUT_FORMAT_NAMES } from '../public/js/shared/output-formats.js';
import { normalisePdfOptions, normalisePdfRenderOptions } from '../public/js/shared/pdf.js';
import { createZip } from '../public/js/shared/zip.js';
import { convertImage, engineVersions } from './convert.js';
import {
  imagesToPdf, pdfEngineVersions, pdfRenderingAvailable, pdfToImages,
} from './pdf.js';
import { jsonHeader, readBody, SECURITY_HEADERS, sendError, sendJson } from './http.js';
import { serveStatic } from './static.js';

const PUBLIC_ROOT = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES) || MAX_FILE_BYTES;
const MAX_BATCH_UPLOAD = Number(process.env.MAX_BATCH_UPLOAD_BYTES) || MAX_BATCH_UPLOAD_BYTES;

/**
 * Read the request body, answering the client directly when it cannot be used.
 * @returns {Promise<Buffer|null>} null once an error response has been sent.
 */
async function readUpload(req, res, limit) {
  let body;
  try {
    body = await readBody(req, limit);
  } catch (error) {
    if (error.code === 'TOO_LARGE') {
      sendError(res, 413, 'TOO_LARGE', `Upload exceeds the ${limit} byte limit.`);
    } else if (error.code !== 'ABORTED') {
      sendError(res, 400, 'BAD_REQUEST', 'Could not read the request body.');
    }
    return null;
  }

  if (body.length === 0) {
    sendError(res, 400, 'EMPTY_FILE', 'Request body was empty.');
    return null;
  }
  return body;
}

/**
 * The client sends the original name percent-encoded so a UTF-8 or
 * newline-bearing name cannot corrupt the header.
 */
function uploadName(req, fallback) {
  const header = req.headers['x-filename'];
  if (typeof header !== 'string') return fallback;
  try {
    return decodeURIComponent(header);
  } catch {
    return fallback;
  }
}

/** Parse query options with `normalise`, answering 400 when they are invalid. */
function readOptions(res, url, normalise) {
  const { options, errors } = normalise(Object.fromEntries(url.searchParams));
  if (errors.length > 0) {
    sendError(res, 400, errors[0].code, errors[0].message);
    return null;
  }
  return options;
}

const sendFailure = (res, error, fallbackCode) =>
  sendError(
    res,
    error.status ?? 500,
    error.code ?? fallbackCode,
    error.message ?? 'Conversion failed.',
  );

async function handleConvert(req, res, url) {
  const options = readOptions(res, url, normaliseOptions);
  if (!options) return;
  const body = await readUpload(req, res, MAX_UPLOAD);
  if (!body) return;
  const originalName = uploadName(req, 'image');

  try {
    const { data, info } = await convertImage(body, options, { name: originalName });
    const outputName = toOutputName(originalName, info.format);
    res.writeHead(200, {
      'content-type': mimeOf(info.format) ?? 'application/octet-stream',
      'content-length': data.length,
      'content-disposition': contentDisposition(outputName, 'inline'),
      'x-image-meta': jsonHeader(info),
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (error) {
    sendFailure(res, error, 'CONVERT_FAILED');
  }
}

/**
 * Images in, one PDF out. Several images arrive as multipart/form-data, in
 * page order; a single image may also be sent as the raw body, exactly as
 * /api/convert takes it.
 */
async function handleImagesToPdf(req, res, url) {
  const options = readOptions(res, url, normalisePdfOptions);
  if (!options) return;
  const body = await readUpload(req, res, MAX_BATCH_UPLOAD);
  if (!body) return;

  const type = String(req.headers['content-type'] ?? '');
  let images;
  if (/^multipart\/form-data/i.test(type)) {
    let form;
    try {
      // The fetch API's multipart parser, built into Node: no dependency.
      form = await new Response(body, { headers: { 'content-type': type } }).formData();
    } catch {
      sendError(res, 400, 'BAD_REQUEST', 'The multipart body could not be parsed.');
      return;
    }
    const files = [...form.values()].filter((value) => typeof value?.arrayBuffer === 'function');
    images = await Promise.all(files.map(async (file) => ({
      name: file.name || 'image',
      data: Buffer.from(await file.arrayBuffer()),
    })));
  } else {
    images = [{ name: uploadName(req, 'image'), data: body }];
  }

  try {
    const { data, info } = await imagesToPdf(images, options);
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': data.length,
      'content-disposition': contentDisposition(info.name, 'inline'),
      'x-pdf-meta': jsonHeader(info),
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (error) {
    sendFailure(res, error, 'PDF_FAILED');
  }
}

/** One PDF in as the raw body; its rendered pages out as a ZIP archive. */
async function handlePdfToImages(req, res, url) {
  const options = readOptions(res, url, normalisePdfRenderOptions);
  if (!options) return;
  const body = await readUpload(req, res, MAX_UPLOAD);
  if (!body) return;
  const originalName = uploadName(req, 'document.pdf');

  try {
    const { pages, info } = await pdfToImages(body, options, { name: originalName });
    const now = new Date();
    const zip = createZip(pages.map((page) => ({ name: page.name, data: page.data, date: now })));
    const zipName = `${replaceExtension(originalName, '', { fallback: 'document' })}-pages.zip`;
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': zip.length,
      'content-disposition': contentDisposition(zipName, 'attachment'),
      // Enough per page for a client to label each entry without re-probing it.
      'x-pdf-meta': jsonHeader({
        ...info,
        pages: pages.map((page) => ({
          page: page.page,
          name: page.name,
          width: page.info.width,
          height: page.info.height,
          bytes: page.data.length,
        })),
      }),
      'cache-control': 'no-store',
    });
    res.end(zip);
  } catch (error) {
    sendFailure(res, error, 'PDF_FAILED');
  }
}

/** POST-only route table; anything else on these paths is a 405. */
const POST_ROUTES = new Map([
  ['/api/convert', handleConvert],
  ['/api/images-to-pdf', handleImagesToPdf],
  ['/api/pdf-to-images', handlePdfToImages],
]);

export function createServer() {
  return http.createServer(async (req, res) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    try {
      if (url.pathname === '/api/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET.');
          return;
        }
        sendJson(res, 200, {
          ok: true,
          engine: 'sharp',
          versions: { ...engineVersions(), ...(await pdfEngineVersions()) },
          maxUploadBytes: MAX_UPLOAD,
          maxBatchUploadBytes: MAX_BATCH_UPLOAD,
          outputFormats: OUTPUT_FORMAT_NAMES,
          // Rendering needs a native canvas; building PDFs is pure JavaScript.
          pdf: { create: true, render: await pdfRenderingAvailable() },
        });
        return;
      }

      const handler = POST_ROUTES.get(url.pathname);
      if (handler) {
        if (req.method !== 'POST') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST, with the file(s) as the body.');
          return;
        }
        await handler(req, res, url);
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (await serveStatic(req, res, PUBLIC_ROOT, url.pathname)) return;
      }

      sendError(res, 404, 'NOT_FOUND', 'Not found.');
    } catch (error) {
      // Last line of defence: never let a throw take the process down or leave
      // a socket hanging open.
      if (!res.headersSent) sendError(res, 500, 'INTERNAL', 'Unexpected server error.');
      else res.destroy();
      console.error('[image-forge]', error);
    }
  });
}

/**
 * Listen until SIGINT/SIGTERM. Resolves with the server once it is accepting
 * connections, and rejects on a bind failure such as EADDRINUSE, so a
 * launcher can move on to another port.
 */
export function startServer({ port = PORT, host = HOST } = {}) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const { sharp: sharpVersion, libvips } = engineVersions();
      console.log(`  Image Forge  ->  http://${host}:${server.address().port}`);
      console.log(`  engine: sharp ${sharpVersion} (libvips ${libvips})`);
      console.log(`  max upload: ${(MAX_UPLOAD / 1024 / 1024).toFixed(0)} MiB`);

      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
          server.close(() => process.exit(0));
          // Don't wait forever on keep-alive sockets during a manual Ctrl-C.
          setTimeout(() => process.exit(0), 2000).unref();
        });
      }
      resolve(server);
    });
  });
}

// Only listen when run directly, so tests can import `createServer` and bind
// an ephemeral port instead.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  startServer().catch((error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `  Port ${PORT} is already in use - set PORT to choose another.`
      : `  error  ${error.message}`);
    process.exit(1);
  });
}
