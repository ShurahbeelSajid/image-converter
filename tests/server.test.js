import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import { createServer } from '../server/index.js';
import { sniffImage } from '../public/js/shared/signature.js';
import { makeJpeg, makePng, notAnImage } from './helpers/fixtures.js';

let server;
let origin;

before(async () => {
  server = createServer();
  // Port 0 asks the OS for a free port, so the suite never collides with a
  // running dev server.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const postImage = (buffer, { query = '', name = 'photo.jpg', type = 'image/jpeg' } = {}) =>
  fetch(`${origin}/api/convert${query}`, {
    method: 'POST',
    headers: { 'content-type': type, 'x-filename': encodeURIComponent(name) },
    body: buffer,
  });

describe('GET /api/health', () => {
  test('reports readiness and engine versions', async () => {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.engine, 'sharp');
    assert.match(body.versions.libvips, /^\d+\.\d+/);
    assert.ok(body.maxUploadBytes > 0);
  });

  test('refuses the wrong method', async () => {
    const response = await fetch(`${origin}/api/health`, { method: 'DELETE' });
    assert.equal(response.status, 405);
    assert.equal((await response.json()).code, 'METHOD_NOT_ALLOWED');
  });
});

describe('POST /api/convert', () => {
  test('converts an uploaded JPEG to WebP', async () => {
    const jpeg = await makeJpeg(200, 150);
    const response = await postImage(jpeg);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');

    const data = new Uint8Array(await response.arrayBuffer());
    const sniff = sniffImage(data);
    assert.equal(sniff.format, 'webp', 'the body really is a WebP file');
    assert.equal(sniff.width, 200);
    assert.equal(sniff.height, 150);
    assert.equal(Number(response.headers.get('content-length')), data.length);
  });

  test('describes the result in the x-image-meta header', async () => {
    const png = await makePng(120, 90);
    const response = await postImage(png, { name: 'shot.png', type: 'image/png' });
    const meta = JSON.parse(response.headers.get('x-image-meta'));

    assert.equal(meta.format, 'webp', 'format is the output format');
    assert.equal(meta.sourceFormat, 'png', 'sourceFormat is what came in');
    assert.equal(meta.width, 120);
    assert.equal(meta.height, 90);
    assert.equal(meta.sourceBytes, png.length);
    assert.equal(meta.bytes, Number(response.headers.get('content-length')));
  });

  test('names the download after the upload, with a .webp extension', async () => {
    const response = await postImage(await makeJpeg(), { name: 'Holiday Photo.JPG' });
    const disposition = response.headers.get('content-disposition');
    assert.match(disposition, /filename="Holiday Photo\.webp"/);
  });

  test('a hostile filename cannot escape the header or the directory', async () => {
    const response = await postImage(await makeJpeg(), { name: '../../etc/passwd.jpg' });
    const disposition = response.headers.get('content-disposition');
    assert.match(disposition, /filename="passwd\.webp"/);
    assert.ok(!disposition.includes('..'), 'no traversal survives');
  });

  test('honours quality and resize options from the query string', async () => {
    const jpeg = await makeJpeg(600, 400);
    const high = await postImage(jpeg, { query: '?quality=95' });
    const low = await postImage(jpeg, { query: '?quality=15' });
    const highBytes = (await high.arrayBuffer()).byteLength;
    const lowBytes = (await low.arrayBuffer()).byteLength;
    assert.ok(lowBytes < highBytes, `q15 (${lowBytes}) < q95 (${highBytes})`);

    const resized = await postImage(jpeg, { query: '?maxWidth=150' });
    const meta = JSON.parse(resized.headers.get('x-image-meta'));
    assert.deepEqual([meta.width, meta.height], [150, 100]);
    assert.equal(meta.resized, true);
  });

  test('clamps a nonsense quality instead of failing the request', async () => {
    const response = await postImage(await makeJpeg(), { query: '?quality=99999' });
    assert.equal(response.status, 200);
  });

  test('rejects an invalid resize target with a 400', async () => {
    const response = await postImage(await makeJpeg(), { query: '?maxWidth=-10' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_OPTION');
  });

  test('rejects a non-image body with a 415', async () => {
    const response = await postImage(notAnImage(), { name: 'evil.png' });
    assert.equal(response.status, 415);
    const body = await response.json();
    assert.equal(body.code, 'UNSUPPORTED_TYPE');
    assert.match(body.error, /not a supported image/i);
  });

  test('rejects an empty body', async () => {
    const response = await fetch(`${origin}/api/convert`, { method: 'POST' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'EMPTY_FILE');
  });

  test('rejects an oversized upload with a 413', async () => {
    // Declared Content-Length alone is enough to refuse it up front.
    const response = await fetch(`${origin}/api/convert`, {
      method: 'POST',
      headers: { 'content-length': String(999 * 1024 * 1024) },
      body: 'x'.repeat(64),
      duplex: 'half',
    }).catch((error) => error);

    // Node may surface the aborted socket as a fetch failure rather than a
    // response; either outcome means the upload was refused.
    if (response instanceof Error) {
      assert.match(response.message, /fetch failed|socket|terminated/i);
      return;
    }
    assert.equal(response.status, 413);
  });

  test('refuses GET on the convert route', async () => {
    const response = await fetch(`${origin}/api/convert`);
    assert.equal(response.status, 405);
  });

  test('a file mislabelled by its extension still converts', async () => {
    // A real JPEG named .png: the bytes decide, so this must succeed.
    const response = await postImage(await makeJpeg(64, 64), { name: 'liar.png' });
    assert.equal(response.status, 200);
    assert.equal(sniffImage(new Uint8Array(await response.arrayBuffer())).format, 'webp');
  });
});

describe('static file serving', () => {
  test('serves the app shell at the root', async () => {
    const response = await fetch(`${origin}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /<title>Image Forge/);
  });

  test('serves modules with a JavaScript content type', async () => {
    // A wrong MIME type here makes the browser refuse the module outright.
    for (const asset of ['/js/app.js', '/js/worker.js', '/js/shared/zip.js']) {
      const response = await fetch(`${origin}${asset}`);
      assert.equal(response.status, 200, `${asset} is served`);
      assert.match(response.headers.get('content-type'), /javascript/, `${asset} MIME`);
    }
  });

  test('sends security headers on every response', async () => {
    const response = await fetch(`${origin}/`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });

  test('revalidates with an ETag', async () => {
    const first = await fetch(`${origin}/js/app.js`);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'an ETag is issued');

    const second = await fetch(`${origin}/js/app.js`, { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304, 'an unchanged asset is not re-sent');
  });

  test('returns 404 for a missing file', async () => {
    const response = await fetch(`${origin}/nope.js`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'NOT_FOUND');
  });

  test('refuses to escape the public root', async () => {
    // Encoded and raw traversal, plus a Windows-style separator. `fetch`
    // normalises some of these, so the request line is built by hand where
    // needed - what matters is that no attempt returns file contents.
    const attempts = [
      '/../package.json',
      '/..%2fpackage.json',
      '/%2e%2e%2fpackage.json',
      '/..%5cpackage.json',
      '/js/../../package.json',
      '/js/%2e%2e/%2e%2e/server/index.js',
    ];
    for (const attempt of attempts) {
      const response = await fetch(`${origin}${attempt}`);
      assert.notEqual(response.status, 200, `${attempt} must not be served`);
      const text = await response.text();
      assert.ok(!text.includes('"image-forge"'), `${attempt} leaked package.json`);
      assert.ok(!text.includes('createServer'), `${attempt} leaked server source`);
    }
  });

  test('a NUL byte in the path is refused', async () => {
    const response = await fetch(`${origin}/index.html%00.png`);
    assert.equal(response.status, 404);
  });
});

describe('POST /api/convert - format and compression parameters', () => {
  test('converts to each requested output format', async () => {
    const png = await makePng(80, 60);
    for (const [format, expectedType] of [
      ['webp', 'image/webp'],
      ['jpeg', 'image/jpeg'],
      ['png', 'image/png'],
      ['avif', 'image/avif'],
      ['gif', 'image/gif'],
      ['tiff', 'image/tiff'],
    ]) {
      const response = await postImage(png, {
        query: `?format=${format}`, name: 'a.png', type: 'image/png',
      });
      assert.equal(response.status, 200, `${format} converts`);
      assert.equal(response.headers.get('content-type'), expectedType, `${format} content-type`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(sniffImage(bytes).format, format, `${format} signature`);
    }
  });

  test('the download name takes the target format extension', async () => {
    const response = await postImage(await makePng(40, 40), {
      query: '?format=jpeg', name: 'Logo.png', type: 'image/png',
    });
    assert.match(response.headers.get('content-disposition'), /filename="Logo\.jpg"/);
  });

  test('"same" re-encodes in the source format', async () => {
    const response = await postImage(await makePng(40, 40), {
      query: '?format=same&quality=50', name: 'a.png', type: 'image/png',
    });
    const meta = JSON.parse(response.headers.get('x-image-meta'));
    assert.equal(meta.format, 'png');
    assert.equal(meta.keptSource, true);
  });

  test('jpg is accepted as an alias for jpeg', async () => {
    const response = await postImage(await makePng(40, 40), { query: '?format=jpg' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
  });

  test('an unknown format is a 400, not a surprise output', async () => {
    const response = await postImage(await makeJpeg(), { query: '?format=bmp' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'INVALID_OPTION');
    assert.match(body.error, /Unknown output format/);
  });

  test('honours a target size and reports the chosen quality', async () => {
    const jpeg = await makeJpeg(1000, 750);
    const response = await postImage(jpeg, { query: '?format=jpeg&targetBytes=25kb' });
    assert.equal(response.status, 200);
    const bytes = await response.arrayBuffer();
    assert.ok(bytes.byteLength <= 25 * 1024, `${bytes.byteLength} <= ${25 * 1024}`);
    const meta = JSON.parse(response.headers.get('x-image-meta'));
    assert.equal(meta.hitTarget, true);
    assert.ok(meta.searchAttempts >= 1);
  });

  test('rejects an unparsable or absurd target size', async () => {
    for (const target of ['huge', '10'] ) {
      const response = await postImage(await makeJpeg(), {
        query: `?targetBytes=${encodeURIComponent(target)}`,
      });
      assert.equal(response.status, 400, `${target} is refused`);
      assert.equal((await response.json()).code, 'INVALID_OPTION');
    }
  });

  test('rejects a malformed background colour', async () => {
    const response = await postImage(await makeJpeg(), {
      query: '?format=jpeg&background=red',
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /hex colour/);
  });

  test('health advertises the writable formats', async () => {
    const body = await fetch(`${origin}/api/health`).then((r) => r.json());
    assert.ok(Array.isArray(body.outputFormats));
    for (const expected of ['webp', 'jpeg', 'png', 'avif']) {
      assert.ok(body.outputFormats.includes(expected), `${expected} is advertised`);
    }
  });
});
