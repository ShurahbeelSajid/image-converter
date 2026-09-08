/**
 * Static file serving for the frontend.
 *
 * Deliberately small: resolve, verify containment, stream. The containment
 * check is the security-relevant part - `path.resolve` collapses "..", and the
 * result must still sit inside the public root before anything is opened.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}));

/**
 * Serve `pathname` from `root`.
 * @returns {Promise<boolean>} false when nothing was served (caller sends 404).
 */
export async function serveStatic(req, res, root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false; // malformed percent-encoding
  }

  // A NUL byte can truncate a path inside lower layers; refuse outright.
  if (decoded.includes('\0')) return false;

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(root, relative);

  // Containment check: `target` must be the root itself or sit beneath it.
  // Comparing with a trailing separator stops "/public-secrets" matching
  // a "/public" root by prefix.
  if (target !== root && !target.startsWith(root + path.sep)) return false;

  let info;
  try {
    info = await stat(target);
  } catch {
    return false;
  }
  if (info.isDirectory()) return serveStatic(req, res, root, `${decoded.replace(/\/+$/, '')}/index.html`);
  if (!info.isFile()) return false;

  // Weak validator built from the fields that change when the file changes.
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return true;
  }

  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME.get(ext) ?? 'application/octet-stream',
    'content-length': info.size,
    etag,
    'last-modified': info.mtime.toUTCString(),
    // Assets are edited during development, so revalidate rather than cache.
    'cache-control': 'no-cache',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  await new Promise((resolve) => {
    const stream = createReadStream(target);
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}
