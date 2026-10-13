import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

import { imagesToPdf, pdfRenderingAvailable, pdfToImages } from '../server/pdf.js';
import { normalisePdfOptions, normalisePdfRenderOptions } from '../public/js/shared/pdf.js';
import { MAX_BATCH_FILES, MAX_PDF_PAGES } from '../public/js/shared/constants.js';
import { sniffImage } from '../public/js/shared/signature.js';
import {
  makeBmp, makeEncryptedPdf, makeJpeg, makeMultiPage, makePdf, makePng, makeQuadrantJpeg,
  makeWebp, notAnImage, readQuadrants, truncatedJpeg,
} from './helpers/fixtures.js';

const pdfOpts = (raw = {}) => normalisePdfOptions(raw).options;
const renderOpts = (raw = {}) => normalisePdfRenderOptions(raw).options;
// `updateMetadata: false`, or pdf-lib rewrites the producer as it loads.
const loadPdf = (pdf) => PDFDocument.load(pdf, { updateMetadata: false });
const pageSizes = async (pdf) =>
  (await loadPdf(pdf)).getPages().map((page) => {
    const { width, height } = page.getSize();
    return [Math.round(width * 100) / 100, Math.round(height * 100) / 100];
  });

/** Assert an async call rejects with the given error code. */
async function rejectsWith(promise, code, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

describe('imagesToPdf', () => {
  test('makes one page per image, in order', async () => {
    const { data, info } = await imagesToPdf([
      { name: 'a.jpg', data: await makeJpeg(96, 48) },
      { name: 'b.png', data: await makePng(48, 96) },
      { name: 'c.webp', data: await makeWebp(96, 96) },
    ], pdfOpts());

    assert.equal(data.subarray(0, 5).toString('latin1'), '%PDF-');
    // Fit-to-image pages: the JPEG records 72 DPI, so a pixel is a point;
    // the PNG and WebP record nothing, so 96 px make an inch (72 pt).
    assert.deepEqual(await pageSizes(data), [[96, 48], [36, 72], [72, 72]]);
    assert.equal(info.pages, 3);
    assert.equal(info.images, 3);
    assert.equal(info.name, 'a.pdf');
  });

  test('embeds a JPEG byte for byte instead of re-encoding it', async () => {
    const jpeg = await makeJpeg(200, 150);
    const { data } = await imagesToPdf([{ name: 'photo.jpg', data: jpeg }], pdfOpts());
    assert.ok(data.includes(jpeg), 'the original JPEG stream is inside the PDF');
  });

  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`an EXIF orientation ${orientation} JPEG renders upright without re-encoding`, async () => {
      const jpeg = await makeQuadrantJpeg(orientation);
      const expected = await readQuadrants(await sharp(jpeg).rotate().png().toBuffer());

      const { data } = await imagesToPdf([{ name: 'turned.jpg', data: jpeg }], pdfOpts());
      assert.ok(data.includes(jpeg), 'still embedded verbatim');

      const { pages } = await pdfToImages(data, renderOpts({ dpi: 96 }));
      assert.deepEqual(await readQuadrants(pages[0].data), expected);
    });
  }

  test('keeps transparency, so the page shows through', async () => {
    // Left half transparent, right half opaque blue.
    const raw = Buffer.alloc(40 * 20 * 4);
    for (let i = 0; i < 40 * 20; i += 1) {
      if (i % 40 >= 20) raw.set([0, 0, 255, 255], i * 4);
    }
    const png = await sharp(raw, { raw: { width: 40, height: 20, channels: 4 } }).png().toBuffer();
    const { data } = await imagesToPdf([{ name: 'clear.png', data: png }], pdfOpts());

    const { pages } = await pdfToImages(data, renderOpts({ dpi: 96, background: '#ff0000' }));
    const { data: pixels, info } = await sharp(pages[0].data).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x) => [...pixels.subarray((10 * info.width + x) * info.channels, (10 * info.width + x) * info.channels + 3)];
    assert.deepEqual(pixel(5), [255, 0, 0], 'the transparent half shows the page');
    assert.deepEqual(pixel(35), [0, 0, 255], 'the opaque half is the image');
  });

  test('a lossless round trip returns the exact pixels', async () => {
    const png = await makePng(64, 48);
    const { data } = await imagesToPdf([{ name: 'exact.png', data: png }], pdfOpts());
    // 72 DPI on a 96-DPI-sized page gives back 48x36; 96 gives the original grid.
    const { pages } = await pdfToImages(data, renderOpts({ dpi: 96 }));
    const original = await sharp(png).flatten({ background: '#ffffff' }).raw().toBuffer();
    const rendered = await sharp(pages[0].data).removeAlpha().raw().toBuffer();
    const differing = original.reduce((n, value, i) => n + (Math.abs(value - rendered[i]) > 2 ? 1 : 0), 0);
    assert.ok(differing / original.length < 0.01, `${differing} of ${original.length} channel values differ`);
  });

  test('compress re-encodes everything as JPEG and flattens transparency', async () => {
    const png = await makePng(300, 200);
    const lossless = await imagesToPdf([{ name: 'a.png', data: png }], pdfOpts());
    const compressed = await imagesToPdf(
      [{ name: 'a.png', data: png }],
      pdfOpts({ compress: true, quality: 60 }),
    );
    assert.ok(compressed.data.includes('/DCTDecode'), 'images are JPEG streams');
    assert.ok(compressed.data.length < lossless.data.length, 'and the PDF is smaller');
    assert.match(compressed.info.warnings.join(' '), /a\.png: JPEG has no transparency/);
  });

  test('a page size scales and centres each image, honouring the margin', async () => {
    const { data } = await imagesToPdf([
      { name: 'wide.jpg', data: await makeJpeg(400, 200) },
      { name: 'tall.jpg', data: await makeJpeg(200, 400) },
    ], pdfOpts({ pageSize: 'a4', margin: 10 }));
    assert.deepEqual(await pageSizes(data), [[841.89, 595.28], [595.28, 841.89]]);
  });

  test('"fit" pages follow the resolution the image records', async () => {
    const scan = await sharp({ create: { width: 2480, height: 3508, channels: 3, background: '#fff' } })
      .withMetadata({ density: 300 })
      .png()
      .toBuffer();
    const [[width, height]] = await pageSizes((await imagesToPdf([{ name: 's.png', data: scan }], pdfOpts())).data);
    assert.ok(Math.abs(width - 595.2) < 0.5 && Math.abs(height - 841.92) < 0.5, `${width}x${height} is A4`);
  });

  test('every page of a multi-page TIFF becomes a PDF page', async () => {
    const { info } = await imagesToPdf(
      [{ name: 'scan.tiff', data: await makeMultiPage('tiff') }],
      pdfOpts(),
    );
    assert.equal(info.pages, 3);
    assert.equal(info.images, 1);
  });

  test('an animated GIF contributes its first frame, and says so', async () => {
    const { data, info } = await imagesToPdf(
      [{ name: 'анимация.gif', data: await makeMultiPage('gif') }],
      pdfOpts(),
    );
    assert.equal(info.pages, 1);
    assert.match(info.warnings[0], /анимация\.gif: animated/);
    const { pages } = await pdfToImages(data, renderOpts({ dpi: 96 }));
    assert.equal((await readQuadrants(pages[0].data)).quadrants, 'RRRR', 'frame one is red');
  });

  test('a greyscale image stays greyscale', async () => {
    const grey = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#808080' } })
      .toColourspace('b-w')
      .png()
      .toBuffer();
    const { data } = await imagesToPdf([{ name: 'g.png', data: grey }], pdfOpts());
    assert.ok(data.includes('/DeviceGray'));
  });

  test('names the file that failed, with a stable code', async () => {
    await rejectsWith(
      imagesToPdf([{ name: 'ok.jpg', data: await makeJpeg() }, { name: 'notes.txt', data: notAnImage() }], pdfOpts()),
      'UNSUPPORTED_TYPE',
      /^notes\.txt: /,
    );
    await rejectsWith(
      imagesToPdf([{ name: 'cut.jpg', data: await truncatedJpeg() }], pdfOpts()),
      'DECODE_FAILED',
      /^cut\.jpg: /,
    );
    await rejectsWith(
      imagesToPdf([{ name: 'old.bmp', data: await makeBmp() }], pdfOpts()),
      'SERVER_CANNOT_DECODE',
    );
    await rejectsWith(
      imagesToPdf([{ name: 'doc.pdf', data: await makePdf() }], pdfOpts()),
      'UNSUPPORTED_TYPE',
      /PDF is a document/,
    );
  });

  test('refuses an empty or oversized batch before decoding anything', async () => {
    await rejectsWith(imagesToPdf([], pdfOpts()), 'EMPTY_FILE');
    const many = Array.from({ length: MAX_BATCH_FILES + 1 }, () => ({ name: 'x.jpg', data: Buffer.alloc(1) }));
    await rejectsWith(imagesToPdf(many, pdfOpts()), 'BATCH_TOO_LARGE');
  });

  test('sets the document title and producer', async () => {
    const { data } = await imagesToPdf(
      [{ name: 'x.jpg', data: await makeJpeg() }],
      pdfOpts({ title: 'Holiday album' }),
    );
    const doc = await loadPdf(data);
    assert.equal(doc.getTitle(), 'Holiday album');
    assert.equal(doc.getProducer(), 'Image Forge');
  });
});

describe('pdfToImages', () => {
  test('rendering is available on this machine', async () => {
    assert.equal(await pdfRenderingAvailable(), true);
  });

  test('renders every page at the requested resolution', async () => {
    const pdf = await makePdf([[595.28, 841.89], [841.89, 595.28]]);
    const { pages, info } = await pdfToImages(pdf, renderOpts({ dpi: 72 }), { name: 'report.pdf' });

    assert.equal(info.pageCount, 2);
    assert.deepEqual(pages.map((page) => page.name), ['report-page-1.png', 'report-page-2.png']);
    assert.deepEqual(pages.map((page) => [page.info.width, page.info.height]), [[595, 842], [842, 595]]);
    for (const page of pages) assert.equal(sniffImage(page.data).format, 'png');
  });

  test('renders only the selected pages', async () => {
    const pdf = await makePdf([[100, 100], [100, 100], [100, 100], [100, 100]]);
    const { pages } = await pdfToImages(pdf, renderOpts({ pages: '2, 4' }));
    assert.deepEqual(pages.map((page) => page.page), [2, 4]);
  });

  test('writes every output format the converter supports', async () => {
    const pdf = await makePdf([[144, 72]]);
    for (const format of ['png', 'jpeg', 'webp', 'avif', 'gif', 'tiff']) {
      const { pages } = await pdfToImages(pdf, renderOpts({ format, dpi: 72 }));
      assert.equal(sniffImage(pages[0].data).format, format, `${format} signature`);
      assert.equal(pages[0].info.sourceFormat, 'pdf');
    }
  });

  test('PNG pages are lossless by default, not palette-quantised', async () => {
    const { data: pdf } = await imagesToPdf([{ name: 'g.png', data: await makePng(120, 90) }], pdfOpts());
    const { pages } = await pdfToImages(pdf, renderOpts({ dpi: 96 }));
    const meta = await sharp(pages[0].data).metadata();
    assert.equal(meta.paletteBitDepth, undefined, 'no palette');
    assert.equal(meta.channels, 3, 'opaque RGB - the page has no transparency');
  });

  test('paints pages onto the chosen background', async () => {
    const { pages } = await pdfToImages(await makePdf([[50, 50]]), renderOpts({ background: '#123456' }));
    const { data } = await sharp(pages[0].data).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 3)], [0x12, 0x34, 0x56]);
  });

  test('passes image options through - resizing and target size', async () => {
    const pdf = await makePdf([[595.28, 841.89]]);
    const { pages } = await pdfToImages(pdf, renderOpts({ format: 'jpeg', maxWidth: 200, targetBytes: '20kb' }));
    assert.equal(pages[0].info.width, 200);
    assert.ok(pages[0].data.length <= 20 * 1024);
  });

  test('renders a giant page at a lower resolution instead of exhausting memory', async () => {
    const { pages, info } = await pdfToImages(await makePdf([[14400, 14400]]), renderOpts({ dpi: 600 }));
    assert.ok(pages[0].info.width <= 20000 && pages[0].info.width * pages[0].info.height <= 40_000_000);
    assert.match(info.warnings[0], /rendered at \d+ DPI/);
  });

  test('leaves the caller\'s buffer intact', async () => {
    // pdf.js detaches whatever buffer it is handed; it must be a copy.
    const pdf = await makePdf();
    const before = Buffer.from(pdf);
    await pdfToImages(pdf, renderOpts({ dpi: 36 }));
    assert.ok(pdf.equals(before));
  });

  test('refuses what it cannot render, with stable codes', async () => {
    await rejectsWith(pdfToImages(await makeJpeg(), renderOpts()), 'UNSUPPORTED_TYPE');
    await rejectsWith(pdfToImages(Buffer.alloc(0), renderOpts()), 'EMPTY_FILE');
    await rejectsWith(
      pdfToImages(Buffer.from('%PDF-1.7\nthis is not really a PDF'), renderOpts()),
      'DECODE_FAILED',
    );
    await rejectsWith(pdfToImages(await makeEncryptedPdf(), renderOpts()), 'PDF_ENCRYPTED', /password/);
    await rejectsWith(
      pdfToImages(await makePdf([[100, 100]]), renderOpts({ pages: '3' })),
      'INVALID_OPTION',
      /Page 3 does not exist/,
    );
  });

  test('caps the pages rendered per request', async () => {
    const pdf = await makePdf(Array.from({ length: MAX_PDF_PAGES + 1 }, () => [20, 20]));
    await rejectsWith(pdfToImages(pdf, renderOpts()), 'TOO_MANY_PAGES', /page range/);
    const { pages } = await pdfToImages(pdf, renderOpts({ pages: '1-2', dpi: 36 }));
    assert.equal(pages.length, 2, 'a range within the cap still works');
  });
});
