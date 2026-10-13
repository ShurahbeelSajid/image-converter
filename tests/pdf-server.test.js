import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import { createServer } from '../server/index.js';
import { jsonHeader } from '../server/http.js';
import { readZip } from '../public/js/shared/zip.js';
import { sniffImage } from '../public/js/shared/signature.js';
import {
  makeJpeg, makeMultiPage, makePdf, makePng, notAnImage,
} from './helpers/fixtures.js';

let server;
let origin;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const meta = (response) => JSON.parse(response.headers.get('x-pdf-meta'));

/** POST images as multipart/form-data, in page order. */
async function postImages(images, query = '') {
  const form = new FormData();
  for (const { name, data } of images) form.append('file', new Blob([data]), name);
  return fetch(`${origin}/api/images-to-pdf${query}`, { method: 'POST', body: form });
}

const postPdf = (pdf, { query = '', name = 'report.pdf' } = {}) =>
  fetch(`${origin}/api/pdf-to-images${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-filename': encodeURIComponent(name) },
    body: pdf,
  });

describe('GET /api/health - PDF support', () => {
  test('advertises both PDF tools and their engine versions', async () => {
    const body = await fetch(`${origin}/api/health`).then((r) => r.json());
    assert.deepEqual(body.pdf, { create: true, render: true });
    assert.match(body.versions.pdfjs, /^\d+\.\d+/);
    assert.match(body.versions.pdfLib, /^\d+\.\d+/);
    assert.ok(body.maxBatchUploadBytes > body.maxUploadBytes);
  });
});

describe('POST /api/images-to-pdf', () => {
  test('binds multipart images into one PDF, in order', async () => {
    const response = await postImages([
      { name: 'cover.jpg', data: await makeJpeg(120, 80) },
      { name: 'page.png', data: await makePng(80, 120) },
    ], '?pageSize=a4&margin=5');

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('content-disposition'), /filename="cover\.pdf"/);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(meta(response).pages, 2);
    assert.equal(meta(response).bytes, body.length);
  });

  test('also takes a single image as the raw body', async () => {
    const response = await fetch(`${origin}/api/images-to-pdf`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'shot.png' },
      body: await makePng(),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /filename="shot\.pdf"/);
  });

  test('names a document after its title', async () => {
    const response = await postImages([{ name: 'a.jpg', data: await makeJpeg() }], '?title=Trip%202026');
    assert.match(response.headers.get('content-disposition'), /filename="Trip 2026\.pdf"/);
  });

  test('a non-ASCII file name in a warning survives the metadata header', async () => {
    // Node refuses header values above U+00FF; the metadata must be escaped.
    const response = await postImages([{ name: 'анимация.gif', data: await makeMultiPage('gif') }]);
    assert.equal(response.status, 200);
    assert.match(meta(response).warnings[0], /^анимация\.gif: animated/);
  });

  test('rejects bad options with a 400 before reading images', async () => {
    const response = await postImages([{ name: 'a.jpg', data: await makeJpeg() }], '?pageSize=b5');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_OPTION');
  });

  test('rejects a file that is not an image, naming it', async () => {
    const response = await postImages([
      { name: 'ok.jpg', data: await makeJpeg() },
      { name: 'notes.txt', data: notAnImage() },
    ]);
    assert.equal(response.status, 415);
    const body = await response.json();
    assert.equal(body.code, 'UNSUPPORTED_TYPE');
    assert.match(body.error, /^notes\.txt: /);
  });

  test('rejects an empty multipart body', async () => {
    const response = await postImages([]);
    assert.ok([400].includes(response.status), `status ${response.status}`);
  });

  test('refuses GET', async () => {
    assert.equal((await fetch(`${origin}/api/images-to-pdf`)).status, 405);
  });
});

describe('POST /api/pdf-to-images', () => {
  test('returns the rendered pages as a ZIP, described by x-pdf-meta', async () => {
    const response = await postPdf(await makePdf([[200, 100], [100, 200]]), { query: '?dpi=72' });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.match(response.headers.get('content-disposition'), /filename="report-pages\.zip"/);

    const entries = readZip(await response.arrayBuffer());
    assert.deepEqual(entries.map((e) => e.name), ['report-page-1.png', 'report-page-2.png']);
    for (const entry of entries) assert.equal(sniffImage(entry.data).format, 'png');

    const info = meta(response);
    assert.equal(info.pageCount, 2);
    assert.deepEqual(info.pages.map((p) => [p.width, p.height]), [[200, 100], [100, 200]]);
  });

  test('honours format and page selection', async () => {
    const response = await postPdf(
      await makePdf([[50, 50], [50, 50], [50, 50]]),
      { query: '?format=jpg&pages=3' },
    );
    const entries = readZip(await response.arrayBuffer());
    assert.deepEqual(entries.map((e) => e.name), ['report-page-3.jpg']);
    assert.equal(sniffImage(entries[0].data).format, 'jpeg');
  });

  test('a page outside the document is a 400 naming the page', async () => {
    const response = await postPdf(await makePdf(), { query: '?pages=4' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Page 4 does not exist/);
  });

  test('an image is refused with a 415', async () => {
    const response = await postPdf(await makePng(), { name: 'x.png' });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).code, 'UNSUPPORTED_TYPE');
  });

  test('a broken PDF is a 422', async () => {
    const response = await postPdf(Buffer.from('%PDF-1.7\nnot a real document'));
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'DECODE_FAILED');
  });

  test('"same" is not a format a PDF page can keep', async () => {
    const response = await postPdf(await makePdf(), { query: '?format=same' });
    assert.equal(response.status, 400);
  });
});

describe('metadata headers', () => {
  test('jsonHeader escapes everything above ASCII and round-trips', () => {
    const value = { name: 'фото – 写真.png', note: 'tab\there' };
    const header = jsonHeader(value);
    assert.ok(/^[\x20-\x7e]*$/.test(header), header);
    assert.deepEqual(JSON.parse(header), value);
  });

  test('/api/convert no longer fails on a non-ASCII extension mismatch', async () => {
    // The warning quotes the extension; before escaping, this was a 500.
    const response = await fetch(`${origin}/api/convert`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent('фото.пнг') },
      body: await makeJpeg(),
    });
    assert.equal(response.status, 200);
    const info = JSON.parse(response.headers.get('x-image-meta'));
    assert.match(info.warnings.join(' '), /Named \.пнг/);
  });
});
