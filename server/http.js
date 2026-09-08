/** Small request/response helpers shared by the routes. */

/** Send a JSON body with no-cache semantics (API responses are never stale). */
export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Send an error in the shape the frontend's fetch wrapper expects. */
export function sendError(res, status, code, message) {
  sendJson(res, status, { error: message, code });
}

/**
 * Read a request body into a single Buffer, aborting once `maxBytes` is
 * exceeded.
 *
 * The Content-Length header is checked first as a cheap rejection, but the
 * running total is what actually enforces the limit - a chunked request can
 * omit or understate the header.
 *
 * @returns {Promise<Buffer>}
 */
export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      const error = new Error(`Body exceeds the ${maxBytes} byte limit.`);
      error.code = 'TOO_LARGE';
      reject(error);
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error(`Body exceeds the ${maxBytes} byte limit.`);
        error.code = 'TOO_LARGE';
        // Stop reading; the socket is destroyed so the client is not left
        // streaming megabytes into a request we have already rejected.
        req.destroy();
        finish(reject, error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks, total)));
    req.on('error', (error) => finish(reject, error));
    req.on('aborted', () => {
      const error = new Error('Client aborted the upload.');
      error.code = 'ABORTED';
      finish(reject, error);
    });
  });
}

/** Headers applied to every response. */
export const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  // The app runs entirely from same-origin assets; blob: covers preview URLs
  // and the object URLs the download flow hands to <a download>.
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' blob: data:",
    "script-src 'self'",
    "style-src 'self'",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
});
