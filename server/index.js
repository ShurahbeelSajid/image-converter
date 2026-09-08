/**
 * HTTP entry point.
 *
 * Plain `node:http` rather than a framework: the whole surface is three routes,
 * and skipping the middleware stack keeps per-request overhead near zero on the
 * hot path (a large binary upload).
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_FILE_BYTES } from '../public/js/shared/constants.js';
import { normaliseOptions } from '../public/js/shared/validation.js';
import { contentDisposition, toOutputName } from '../public/js/shared/filename.js';
import { mimeOf, OUTPUT_FORMAT_NAMES } from '../public/js/shared/output-formats.js';
import { convertImage, engineVersions } from './convert.js';
import { readBody, SECURITY_HEADERS, sendError, sendJson } from './http.js';
import { serveStatic } from './static.js';

const PUBLIC_ROOT = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES) || MAX_FILE_BYTES;

async function handleConvert(req, res, url) {
  const { options, errors } = normaliseOptions(Object.fromEntries(url.searchParams));
  if (errors.length > 0) {
    sendError(res, 400, errors[0].code, errors[0].message);
    return;
  }

  let body;
  try {
    body = await readBody(req, MAX_UPLOAD);
  } catch (error) {
    if (error.code === 'TOO_LARGE') {
      sendError(res, 413, 'TOO_LARGE', `Upload exceeds the ${MAX_UPLOAD} byte limit.`);
    } else if (error.code !== 'ABORTED') {
      sendError(res, 400, 'BAD_REQUEST', 'Could not read the request body.');
    }
    return;
  }

  if (body.length === 0) {
    sendError(res, 400, 'EMPTY_FILE', 'Request body was empty.');
    return;
  }

  // The client sends the original name percent-encoded so a UTF-8 or
  // newline-bearing name cannot corrupt the header.
  let originalName = 'image';
  const header = req.headers['x-filename'];
  if (typeof header === 'string') {
    try {
      originalName = decodeURIComponent(header);
    } catch {
      /* keep the fallback */
    }
  }

  try {
    const { data, info } = await convertImage(body, options, { name: originalName });
    const outputName = toOutputName(originalName, info.format);
    res.writeHead(200, {
      'content-type': mimeOf(info.format) ?? 'application/octet-stream',
      'content-length': data.length,
      'content-disposition': contentDisposition(outputName, 'inline'),
      'x-image-meta': JSON.stringify(info),
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (error) {
    sendError(
      res,
      error.status ?? 500,
      error.code ?? 'CONVERT_FAILED',
      error.message ?? 'Conversion failed.',
    );
  }
}

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
          versions: engineVersions(),
          maxUploadBytes: MAX_UPLOAD,
          outputFormats: OUTPUT_FORMAT_NAMES,
        });
        return;
      }

      if (url.pathname === '/api/convert') {
        if (req.method !== 'POST') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST with the file as the raw body.');
          return;
        }
        await handleConvert(req, res, url);
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

// Only listen when run directly, so tests can import `createServer` and bind
// an ephemeral port instead.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    const { sharp: sharpVersion, libvips } = engineVersions();
    console.log(`  Image Forge  ->  http://${HOST}:${PORT}`);
    console.log(`  engine: sharp ${sharpVersion} (libvips ${libvips})`);
    console.log(`  max upload: ${(MAX_UPLOAD / 1024 / 1024).toFixed(0)} MiB`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      // Don't wait forever on keep-alive sockets during a manual Ctrl-C.
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
