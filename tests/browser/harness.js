/**
 * End-to-end browser tests.
 *
 * Runs inside real headless Chrome against the real modules the app ships, so
 * the worker pool, OffscreenCanvas encoding and object-URL plumbing are all
 * genuinely exercised rather than mocked. Results are POSTed back to the test
 * runner, which is far more reliable than trying to time a DOM dump.
 */

import { convert, supportsLocalEncoding, cancelAll } from '/js/converter.js';
import { normaliseOptions } from '/js/shared/validation.js';
import { createZip } from '/js/shared/zip.js';
import { sniffImage } from '/js/shared/signature.js';
import { toOutputName } from '/js/shared/filename.js';
import { imagesToPdf, pdfToImages } from '/js/pdf-client.js';
import { normalisePdfOptions, normalisePdfRenderOptions } from '/js/shared/pdf.js';

const results = [];
const log = document.getElementById('log');

async function check(name, fn) {
  const startedAt = performance.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Math.round(performance.now() - startedAt) });
    log.textContent += `PASS  ${name}\n`;
  } catch (error) {
    results.push({ name, ok: false, error: error?.message ?? String(error) });
    log.textContent += `FAIL  ${name}: ${error?.message}\n`;
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const assertEqual = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
};

/** Build a real image File in the page, so nothing is smuggled in from Node. */
async function makeImageFile(name, type, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#ff0055');
  gradient.addColorStop(0.5, '#00d4ff');
  gradient.addColorStop(1, '#ffee00');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  // Detail the encoder has to work at, so quality changes move the file size.
  for (let i = 0; i < 60; i += 1) {
    ctx.fillStyle = `hsl(${(i * 37) % 360} 90% 50%)`;
    ctx.fillRect((i * 37) % width, (i * 53) % height, 9, 9);
  }
  const blob = await canvas.convertToBlob({ type, quality: 0.95 });
  return new File([blob], name, { type, lastModified: Date.now() });
}

/** Decoded dimensions of an encoded blob, straight from the browser decoder. */
async function decodedSize(bytes, type = 'image/webp') {
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/** A PNG that is fully transparent on the left half, opaque red on the right. */
async function makeTransparentPng(width = 40, height = 20) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(width / 2, 0, width / 2, height);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new File([blob], 'alpha.png', { type: 'image/png' });
}

/** RGBA of one pixel of an encoded image, decoded by the browser. */
async function pixelAt(bytes, type, x, y) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return [...ctx.getImageData(x, y, 1, 1).data];
}

const opts = (overrides) => normaliseOptions(overrides).options;

async function run() {
  const serverAvailable = await fetch('/api/health').then((r) => r.ok).catch(() => false);
  const context = { engine: 'browser', serverAvailable: false };

  await check('browser reports local WebP encoding support', () => {
    assert(supportsLocalEncoding(), 'OffscreenCanvas WebP encoding should be available');
  });

  await check('converts a PNG to a real WebP in a worker', async () => {
    const file = await makeImageFile('test.png', 'image/png', 200, 150);
    const result = await convert(file, opts({ quality: 80 }), context);
    assertEqual(sniffImage(result.bytes).format, 'webp', 'output signature');
    assertEqual(result.engine, 'browser', 'engine used');
    assertEqual(result.width, 200, 'width');
    assertEqual(result.height, 150, 'height');
    assert(result.bytes.length > 0, 'output is not empty');
  });

  await check('converts a JPEG to WebP', async () => {
    const file = await makeImageFile('test.jpg', 'image/jpeg', 160, 120);
    const result = await convert(file, opts({ quality: 80 }), context);
    assertEqual(sniffImage(result.bytes).format, 'webp', 'output signature');
    assertEqual(result.format, 'webp', 'output format');
    assertEqual(result.sourceFormat, 'jpeg', 'detected source format');
  });

  await check('the encoded WebP decodes back at the right size', async () => {
    const file = await makeImageFile('test.png', 'image/png', 123, 77);
    const result = await convert(file, opts(), context);
    const size = await decodedSize(result.bytes);
    assertEqual(size.width, 123, 'decoded width');
    assertEqual(size.height, 77, 'decoded height');
  });

  await check('lower quality produces a smaller file', async () => {
    const file = await makeImageFile('q.png', 'image/png', 400, 300);
    const high = await convert(file, opts({ quality: 95 }), context);
    const low = await convert(file, opts({ quality: 10 }), context);
    assert(
      low.bytes.length < high.bytes.length,
      `q10 (${low.bytes.length}B) should be smaller than q95 (${high.bytes.length}B)`,
    );
  });

  await check('maxWidth downscales and preserves aspect ratio', async () => {
    const file = await makeImageFile('big.png', 'image/png', 800, 400);
    const result = await convert(file, opts({ maxWidth: 200 }), context);
    assertEqual(result.width, 200, 'width');
    assertEqual(result.height, 100, 'height');
    assertEqual(result.resized, true, 'resized flag');
    const size = await decodedSize(result.bytes);
    assertEqual(size.width, 200, 'decoded width');
  });

  await check('never upscales a small image', async () => {
    const file = await makeImageFile('small.png', 'image/png', 40, 30);
    const result = await convert(file, opts({ maxWidth: 4000, maxHeight: 4000 }), context);
    assertEqual(result.width, 40, 'width unchanged');
    assertEqual(result.resized, false, 'resized flag');
  });

  await check('a browser lossless request warns that it is not truly lossless', async () => {
    const file = await makeImageFile('ll.png', 'image/png', 64, 64);
    const result = await convert(file, opts({ lossless: true }), context);
    assert(
      result.warnings.some((w) => /lossless/i.test(w)),
      `expected a lossless caveat, got ${JSON.stringify(result.warnings)}`,
    );
  });

  await check('converts JPG to PNG in the browser', async () => {
    const file = await makeImageFile('shot.jpg', 'image/jpeg', 120, 90);
    const result = await convert(file, opts({ format: 'png' }), context);
    assertEqual(sniffImage(result.bytes).format, 'png', 'output signature');
    assertEqual(result.format, 'png', 'reported format');
    assertEqual(result.sourceFormat, 'jpeg', 'reported source');
    const size = await decodedSize(result.bytes, 'image/png');
    assertEqual(size.width, 120, 'decoded width');
  });

  await check('converts PNG to JPG, flattening transparency onto the background', async () => {
    const file = await makeTransparentPng(40, 20);
    const white = await convert(file, opts({ format: 'jpeg', background: '#ffffff' }), context);
    assertEqual(sniffImage(white.bytes).format, 'jpeg', 'output signature');

    // Top-left is in the transparent half; JPEG has no alpha, so it must have
    // become the background colour rather than black.
    const [r, g, b, a] = await pixelAt(white.bytes, 'image/jpeg', 1, 1);
    assert(r > 240 && g > 240 && b > 240, `expected near-white, got rgb(${r},${g},${b})`);
    assertEqual(a, 255, 'opaque');
    assert(
      white.warnings.some((w) => /no transparency/i.test(w)),
      'the flattening is reported',
    );

    const black = await convert(file, opts({ format: 'jpeg', background: '#000000' }), context);
    const [r2, g2, b2] = await pixelAt(black.bytes, 'image/jpeg', 1, 1);
    assert(r2 < 15 && g2 < 15 && b2 < 15, `expected near-black, got rgb(${r2},${g2},${b2})`);
  });

  await check('WebP keeps transparency that JPEG would have to drop', async () => {
    const file = await makeTransparentPng(40, 20);
    const result = await convert(file, opts({ format: 'webp' }), context);
    const [, , , alpha] = await pixelAt(result.bytes, 'image/webp', 1, 1);
    assertEqual(alpha, 0, 'the transparent pixel is still transparent');
  });

  await check('"same as source" re-encodes in the original format', async () => {
    const jpg = await makeImageFile('a.jpg', 'image/jpeg', 100, 80);
    const png = await makeImageFile('a.png', 'image/png', 100, 80);
    const fromJpg = await convert(jpg, opts({ format: 'original' }), context);
    const fromPng = await convert(png, opts({ format: 'original' }), context);
    assertEqual(fromJpg.format, 'jpeg', 'jpeg stays jpeg');
    assertEqual(fromPng.format, 'png', 'png stays png');
    assertEqual(sniffImage(fromJpg.bytes).format, 'jpeg', 'jpeg signature');
    assertEqual(sniffImage(fromPng.bytes).format, 'png', 'png signature');
  });

  await check('target size compresses to fit the budget in the browser', async () => {
    const file = await makeImageFile('big.jpg', 'image/jpeg', 900, 700);
    const target = 25 * 1024;
    const result = await convert(
      file, opts({ format: 'jpeg', targetBytes: '25kb' }), context,
    );
    assert(
      result.bytes.length <= target,
      `${result.bytes.length} should be within ${target}`,
    );
    assertEqual(result.hitTarget, true, 'hit the target');
    assert(result.searchAttempts >= 1, 'the search ran');
  });

  await check('a browser-only AVIF request fails with a recoverable code', async () => {
    // Canvas cannot encode AVIF; the error must say so rather than silently
    // handing back a PNG.
    const file = await makeImageFile('a.png', 'image/png', 60, 40);
    let threw = null;
    try {
      await convert(file, opts({ format: 'avif' }), { engine: 'browser', serverAvailable: false });
    } catch (error) {
      threw = error;
    }
    assert(threw, 'should have rejected');
    assertEqual(threw.code, 'FORMAT_NEEDS_SERVER', 'error code');
  });

  await check('rejects a file whose bytes are not an image', async () => {
    const file = new File([new TextEncoder().encode('definitely not an image')],
      'fake.png', { type: 'image/png' });
    let threw = null;
    try {
      await convert(file, opts(), context);
    } catch (error) {
      threw = error;
    }
    assert(threw, 'should have rejected');
    assertEqual(threw.code, 'UNSUPPORTED_TYPE', 'error code');
  });

  await check('rejects an empty file', async () => {
    const file = new File([], 'empty.png', { type: 'image/png' });
    let threw = null;
    try {
      await convert(file, opts(), context);
    } catch (error) {
      threw = error;
    }
    assert(threw, 'should have rejected');
    assertEqual(threw.code, 'EMPTY_FILE', 'error code');
  });

  await check('rejects a declared pixel bomb before decoding', async () => {
    // A PNG header claiming 60000x60000 with no pixels behind it.
    const header = new Uint8Array(24);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(header.buffer).setUint32(8, 13);
    header.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
    new DataView(header.buffer).setUint32(16, 60000);
    new DataView(header.buffer).setUint32(20, 60000);
    const file = new File([header], 'bomb.png', { type: 'image/png' });

    let threw = null;
    try {
      await convert(file, opts(), context);
    } catch (error) {
      threw = error;
    }
    assert(threw, 'should have rejected');
    assertEqual(threw.code, 'DIMENSIONS_TOO_LARGE', 'error code');
  });

  await check('the worker pool converts a batch in parallel', async () => {
    const files = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        makeImageFile(`batch-${i}.png`, 'image/png', 260, 200)),
    );
    const startedAt = performance.now();
    const converted = await Promise.all(files.map((f) => convert(f, opts(), context)));
    const elapsed = performance.now() - startedAt;

    assertEqual(converted.length, 12, 'all conversions resolved');
    for (const [i, result] of converted.entries()) {
      assertEqual(sniffImage(result.bytes).format, 'webp', `item ${i} is WebP`);
    }
    // Recorded for the report; wall-clock beats the summed per-item time when
    // work really is running across several workers.
    const summed = converted.reduce((total, r) => total + r.ms, 0);
    results.push({ name: '  (batch timing)', ok: true, note: `12 images: ${Math.round(elapsed)}ms wall, ${Math.round(summed)}ms summed` });
  });

  await check('batch output names are unique and end in .webp', async () => {
    const taken = new Set();
    const { uniqueName } = await import('/js/shared/filename.js');
    const names = ['a.png', 'a.png', 'a.jpg'].map((n) => uniqueName(toOutputName(n, 'webp'), taken));
    assertEqual(names[0], 'a.webp', 'first');
    assertEqual(names[1], 'a (2).webp', 'second');
    assertEqual(names[2], 'a (3).webp', 'third');
  });

  await check('a batch zips into a valid archive in the browser', async () => {
    const files = await Promise.all([
      makeImageFile('one.png', 'image/png', 80, 60),
      makeImageFile('two.png', 'image/png', 80, 60),
    ]);
    const converted = await Promise.all(files.map((f) => convert(f, opts(), context)));
    const zip = createZip(
      converted.map((r, i) => ({ name: `image-${i}.webp`, data: r.bytes })),
    );
    const view = new DataView(zip.buffer);
    assertEqual(view.getUint32(0, true), 0x04034b50, 'local header signature');
    assertEqual(view.getUint32(zip.length - 22, true), 0x06054b50, 'EOCD signature');
    assertEqual(view.getUint16(zip.length - 22 + 10, true), 2, 'entry count');
  });

  await check('object URLs can be created and revoked for previews', async () => {
    const file = await makeImageFile('url.png', 'image/png', 32, 32);
    const result = await convert(file, opts(), context);
    const url = URL.createObjectURL(new Blob([result.bytes], { type: 'image/webp' }));
    assert(url.startsWith('blob:'), 'a blob URL is produced');
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('the browser could not render the WebP output'));
      image.src = url;
    });
    assertEqual(image.naturalWidth, 32, 'rendered width');
    URL.revokeObjectURL(url);
  });

  if (serverAvailable) {
    await check('the server engine converts over HTTP', async () => {
      const file = await makeImageFile('server.png', 'image/png', 150, 100);
      const result = await convert(file, opts({ quality: 70 }), {
        engine: 'server', serverAvailable: true,
      });
      assertEqual(result.engine, 'server', 'engine used');
      assertEqual(sniffImage(result.bytes).format, 'webp', 'output signature');
      assertEqual(result.width, 150, 'width from x-image-meta');
    });

    await check('auto engine routes an AVIF request to the server', async () => {
      const file = await makeImageFile('a.png', 'image/png', 80, 60);
      const result = await convert(file, opts({ format: 'avif' }), {
        engine: 'auto', serverAvailable: true,
      });
      assertEqual(result.engine, 'server', 'engine used');
      assertEqual(sniffImage(result.bytes).format, 'avif', 'output signature');
    });

    await check('auto engine routes PNG quantisation to the server', async () => {
      // Canvas PNG is strictly lossless, so a sub-100 quality would be a no-op
      // in the browser; sharp can actually quantise.
      const file = await makeImageFile('a.png', 'image/png', 200, 150);
      const result = await convert(file, opts({ format: 'png', quality: 60 }), {
        engine: 'auto', serverAvailable: true,
      });
      assertEqual(result.engine, 'server', 'engine used');
      assertEqual(sniffImage(result.bytes).format, 'png', 'output signature');
    });

    await check('auto engine sends a lossless request to the server', async () => {
      // Canvas cannot do lossless, so auto must not silently encode it lossy.
      const file = await makeImageFile('ll2.png', 'image/png', 64, 64);
      const result = await convert(file, opts({ lossless: true }), {
        engine: 'auto', serverAvailable: true,
      });
      assertEqual(result.engine, 'server', 'engine used');
      assertEqual(sniffImage(result.bytes).format, 'webp', 'output signature');
    });

    await check('a server-side rejection surfaces as a coded error', async () => {
      const file = new File([new TextEncoder().encode('not an image')], 'x.png',
        { type: 'image/png' });
      let threw = null;
      try {
        await convert(file, opts(), { engine: 'server', serverAvailable: true });
      } catch (error) {
        threw = error;
      }
      assert(threw, 'should have rejected');
      assertEqual(threw.code, 'UNSUPPORTED_TYPE', 'error code');
    });

    let builtPdf = null;
    await check('images bind into a PDF over HTTP, in order', async () => {
      const images = [
        { file: await makeImageFile('cover.jpg', 'image/jpeg', 120, 80), format: 'jpeg' },
        { file: await makeImageFile('page.png', 'image/png', 80, 120), format: 'png' },
      ];
      const { bytes, meta } = await imagesToPdf(images, normalisePdfOptions().options);
      assertEqual(new TextDecoder().decode(bytes.subarray(0, 5)), '%PDF-', 'PDF header');
      assertEqual(meta.pages, 2, 'page count from x-pdf-meta');
      assertEqual(meta.name, 'cover.pdf', 'named after the first image');
      builtPdf = bytes;
    });

    await check('a BMP is bridged to PNG in the browser before it is bound', async () => {
      // libvips cannot read BMP, so this only succeeds if the bridge ran.
      const width = 4;
      const height = 4;
      const stride = Math.ceil((width * 3) / 4) * 4;
      const bmp = new Uint8Array(54 + stride * height);
      const view = new DataView(bmp.buffer);
      bmp.set([0x42, 0x4d]);
      view.setUint32(2, bmp.length, true);
      view.setUint32(10, 54, true);
      view.setUint32(14, 40, true);
      view.setInt32(18, width, true);
      view.setInt32(22, height, true);
      view.setUint16(26, 1, true);
      view.setUint16(28, 24, true);
      const file = new File([bmp], 'old.bmp', { type: 'image/bmp' });
      const { meta } = await imagesToPdf([{ file, format: 'bmp' }], normalisePdfOptions().options);
      assertEqual(meta.pages, 1, 'page count');
    });

    await check('a PDF renders back to images, unpacked from the ZIP in the browser', async () => {
      assert(builtPdf, 'needs the PDF from the earlier check');
      const file = new File([builtPdf], 'cover.pdf', { type: 'application/pdf' });
      const { pages, meta } = await pdfToImages(
        file,
        normalisePdfRenderOptions({ format: 'jpeg', dpi: 72 }).options,
      );
      assertEqual(meta.pageCount, 2, 'pages in the document');
      assertEqual(pages.length, 2, 'pages unpacked');
      assertEqual(pages[0].name, 'cover-page-1.jpg', 'entry name');
      assertEqual(sniffImage(pages[0].bytes).format, 'jpeg', 'entry signature');
      const size = await decodedSize(pages[1].bytes, 'image/jpeg');
      assertEqual(size.width, pages[1].width, 'decoded width matches the metadata');
    });

    await check('a PDF tool rejection surfaces as a coded error', async () => {
      const file = await makeImageFile('not-a.pdf', 'image/png', 10, 10);
      let threw = null;
      try {
        await pdfToImages(file, normalisePdfRenderOptions().options);
      } catch (error) {
        threw = error;
      }
      assert(threw, 'should have rejected');
      assertEqual(threw.code, 'UNSUPPORTED_TYPE', 'error code');
    });
  }

  cancelAll();

  const payload = {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    results,
  };
  await fetch('/__results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  document.title = 'DONE';
}

run().catch(async (error) => {
  await fetch('/__results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fatal: error?.stack ?? String(error), results }),
  });
});
