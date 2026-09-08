import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import sharp from 'sharp';

import { convertImage, engineVersions } from '../server/convert.js';
import { normaliseOptions } from '../public/js/shared/validation.js';
import { sniffImage } from '../public/js/shared/signature.js';
import {
  makeGif, makeJpeg, makePixelBombHeader, makePng, makeRotatedJpeg, makeTiff, makeWebp,
  notAnImage, truncatedJpeg,
} from './helpers/fixtures.js';

const opts = (overrides = {}) => normaliseOptions({ format: 'webp', ...overrides }).options;

/** Assert a buffer really is a WebP file, not just something we labelled one. */
const assertWebp = (data) => {
  const sniff = sniffImage(data);
  assert.equal(sniff.format, 'webp', 'output carries the RIFF/WEBP signature');
  return sniff;
};

describe('convertImage (webp) - formats', () => {
  test('converts every browser-supported input format', async () => {
    const inputs = {
      jpeg: await makeJpeg(120, 90),
      png: await makePng(120, 90),
      gif: await makeGif(120, 90),
      webp: await makeWebp(120, 90),
      tiff: await makeTiff(120, 90),
    };
    for (const [label, input] of Object.entries(inputs)) {
      const { data, info } = await convertImage(input, opts(), { name: `x.${label}` });
      const sniff = assertWebp(data);
      assert.equal(info.format, 'webp', `reports the output format for ${label}`);
      assert.equal(info.sourceFormat, label, `reports the source format for ${label}`);
      assert.equal(info.width, 120, `width preserved for ${label}`);
      assert.equal(info.height, 90, `height preserved for ${label}`);
      assert.equal(sniff.width, 120, `encoded header agrees for ${label}`);
      assert.equal(sniff.height, 90);
    }
  });

  test('output dimensions match the source when not resizing', async () => {
    const { info } = await convertImage(await makeJpeg(321, 199), opts(), { name: 'odd.jpg' });
    assert.deepEqual([info.width, info.height], [321, 199]);
    assert.equal(info.resized, false);
  });

  test('preserves the alpha channel from a transparent PNG', async () => {
    const png = await sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();

    const { data } = await convertImage(png, opts({ lossless: true }), { name: 'clear.png' });
    assertWebp(data);
    const meta = await sharp(data).metadata();
    assert.equal(meta.hasAlpha, true, 'alpha survives the round trip');

    const { data: pixels } = await sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(pixels[3], 0, 'the transparent pixel is still transparent');
  });
});

describe('convertImage (webp) - encoding options', () => {
  test('lower quality yields a smaller file', async () => {
    const jpeg = await makeJpeg(400, 300);
    const high = await convertImage(jpeg, opts({ quality: 95 }), { name: 'a.jpg' });
    const low = await convertImage(jpeg, opts({ quality: 20 }), { name: 'a.jpg' });
    assert.ok(
      low.data.length < high.data.length,
      `q20 (${low.data.length}B) should be smaller than q95 (${high.data.length}B)`,
    );
  });

  test('lossless is byte-exact for the pixel data', async () => {
    const png = await makePng(64, 48);
    const { data } = await convertImage(png, opts({ lossless: true }), { name: 'a.png' });
    assertWebp(data);

    const source = await sharp(png).ensureAlpha().raw().toBuffer();
    const round = await sharp(data).ensureAlpha().raw().toBuffer();
    assert.deepEqual(round, source, 'every pixel survives a lossless round trip');
  });

  test('lossy encoding is not byte-exact, confirming the flag does something', async () => {
    const png = await makePng(64, 48);
    const { data } = await convertImage(png, opts({ quality: 40 }), { name: 'a.png' });
    const source = await sharp(png).ensureAlpha().raw().toBuffer();
    const round = await sharp(data).ensureAlpha().raw().toBuffer();
    assert.notDeepEqual(round, source);
  });

  test('metadata is stripped by default and kept on request', async () => {
    const withExif = await sharp(await makeJpeg(64, 48))
      .withMetadata({ exif: { IFD0: { Software: 'webp-forge-test' } } })
      .toBuffer();

    const stripped = await convertImage(withExif, opts(), { name: 'a.jpg' });
    assert.equal((await sharp(stripped.data).metadata()).exif, undefined, 'EXIF removed');

    const kept = await convertImage(withExif, opts({ keepMetadata: true }), { name: 'a.jpg' });
    assert.ok((await sharp(kept.data).metadata()).exif, 'EXIF preserved');
  });
});

describe('convertImage (webp) - resizing', () => {
  test('fits inside the box and preserves aspect ratio', async () => {
    const jpeg = await makeJpeg(800, 400);
    const { info } = await convertImage(jpeg, opts({ maxWidth: 200 }), { name: 'a.jpg' });
    assert.deepEqual([info.width, info.height], [200, 100]);
    assert.equal(info.resized, true);
  });

  test('the smaller constraint wins', async () => {
    const jpeg = await makeJpeg(800, 400);
    const { info } = await convertImage(
      jpeg, opts({ maxWidth: 400, maxHeight: 100 }), { name: 'a.jpg' },
    );
    assert.deepEqual([info.width, info.height], [200, 100]);
  });

  test('never upscales a small source', async () => {
    const jpeg = await makeJpeg(50, 40);
    const { info } = await convertImage(
      jpeg, opts({ maxWidth: 4000, maxHeight: 4000 }), { name: 'a.jpg' },
    );
    assert.deepEqual([info.width, info.height], [50, 40]);
    assert.equal(info.resized, false);
  });

  test('resizing actually shrinks the encoded output', async () => {
    const jpeg = await makeJpeg(800, 600);
    const full = await convertImage(jpeg, opts(), { name: 'a.jpg' });
    const small = await convertImage(jpeg, opts({ maxWidth: 200 }), { name: 'a.jpg' });
    assert.ok(small.data.length < full.data.length);
  });
});

describe('convertImage (webp) - EXIF orientation', () => {
  test('applies the stored orientation to the output', async () => {
    // Stored 64x32 with orientation 6 (rotate 90 deg) displays as 32x64.
    const rotated = await makeRotatedJpeg(64, 32, 6);
    const { info } = await convertImage(rotated, opts(), { name: 'r.jpg' });
    assert.deepEqual([info.sourceWidth, info.sourceHeight], [32, 64], 'source reported upright');
    assert.deepEqual([info.width, info.height], [32, 64], 'output is upright');
  });

  test('rotates before resizing, so the fit box applies to the upright image', async () => {
    const rotated = await makeRotatedJpeg(64, 32, 6); // displays as 32x64
    const { info } = await convertImage(rotated, opts({ maxWidth: 16 }), { name: 'r.jpg' });
    // Fitting the upright 32x64 to width 16 gives 16x32. Resizing first would
    // have produced 16x8, so this pins the pipeline order.
    assert.deepEqual([info.width, info.height], [16, 32]);
  });

  test('an unrotated image is unaffected', async () => {
    const { info } = await convertImage(await makeJpeg(64, 32), opts(), { name: 'p.jpg' });
    assert.deepEqual([info.width, info.height], [64, 32]);
  });
});

describe('convertImage (webp) - rejections', () => {
  test('rejects content that is not an image', async () => {
    await assert.rejects(
      () => convertImage(notAnImage(), opts(), { name: 'evil.png' }),
      (error) => {
        assert.equal(error.code, 'UNSUPPORTED_TYPE');
        assert.equal(error.status, 415);
        return true;
      },
    );
  });

  test('rejects a truncated image rather than emitting partial output', async () => {
    const cut = await truncatedJpeg();
    await assert.rejects(
      () => convertImage(cut, opts(), { name: 'cut.jpg' }),
      (error) => {
        assert.equal(error.code, 'DECODE_FAILED');
        assert.equal(error.status, 422);
        return true;
      },
    );
  });

  test('rejects a declared pixel bomb before decoding', async () => {
    await assert.rejects(
      () => convertImage(makePixelBombHeader(60_000, 60_000), opts(), { name: 'bomb.png' }),
      (error) => {
        assert.equal(error.code, 'DIMENSIONS_TOO_LARGE');
        return true;
      },
    );
  });

  test('rejects an empty buffer', async () => {
    await assert.rejects(
      () => convertImage(Buffer.alloc(0), opts(), { name: 'empty.png' }),
      (error) => {
        assert.equal(error.code, 'EMPTY_FILE');
        return true;
      },
    );
  });

  test('an SVG is refused with an actionable message', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await assert.rejects(
      () => convertImage(svg, opts(), { name: 'logo.svg' }),
      /vector/i,
    );
  });
});

describe('convertImage (webp) - reporting', () => {
  test('reports byte counts and a plausible duration', async () => {
    const jpeg = await makeJpeg(200, 150);
    const { data, info } = await convertImage(jpeg, opts(), { name: 'a.jpg' });
    assert.equal(info.sourceBytes, jpeg.length);
    assert.equal(info.bytes, data.length);
    assert.ok(Number.isInteger(info.ms) && info.ms >= 0, 'duration is a whole number of ms');
  });

  test('exposes engine versions for the health endpoint', () => {
    const versions = engineVersions();
    assert.match(versions.sharp, /^\d+\.\d+\.\d+/);
    assert.match(versions.libvips, /^\d+\.\d+/);
  });
});
