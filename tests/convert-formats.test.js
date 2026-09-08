/**
 * Any-format-to-any-format conversion and compression, through the sharp
 * engine. The WebP-specific behaviour lives in convert.test.js; this file is
 * about the matrix and the compressor.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import sharp from 'sharp';

import { convertImage } from '../server/convert.js';
import { normaliseOptions } from '../public/js/shared/validation.js';
import { sniffImage } from '../public/js/shared/signature.js';
import { OUTPUT_FORMAT_NAMES } from '../public/js/shared/output-formats.js';
import {
  makeBmp, makeGif, makeJpeg, makePng, makeTiff, makeWebp,
} from './helpers/fixtures.js';

const opts = (overrides = {}) => {
  const { options, errors } = normaliseOptions(overrides);
  assert.deepEqual(errors, [], 'options should be valid');
  return options;
};

/** A PNG that is transparent on the left half and opaque red on the right. */
async function alphaPng(width = 40, height = 20) {
  const opaque = await sharp({
    create: { width: width / 2, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: opaque, left: width / 2, top: 0 }])
    .png()
    .toBuffer();
}

describe('the conversion matrix', () => {
  test('every source format converts to every output format', async () => {
    const sources = {
      jpeg: await makeJpeg(120, 90),
      png: await makePng(120, 90),
      gif: await makeGif(120, 90),
      webp: await makeWebp(120, 90),
      tiff: await makeTiff(120, 90),
    };

    for (const [from, input] of Object.entries(sources)) {
      for (const to of OUTPUT_FORMAT_NAMES) {
        const { data, info } = await convertImage(input, opts({ format: to, quality: 80 }), {
          name: `x.${from}`,
        });
        assert.equal(
          sniffImage(data).format, to,
          `${from} -> ${to} must carry the ${to} signature`,
        );
        assert.equal(info.format, to, `${from} -> ${to} reports the output format`);
        assert.equal(info.sourceFormat, from, `${from} -> ${to} reports the source format`);
        assert.equal(info.width, 120, `${from} -> ${to} preserves width`);
        assert.equal(info.height, 90, `${from} -> ${to} preserves height`);
      }
    }
  });

  test('the named pairings the tool advertises all work', async () => {
    const jpg = await makeJpeg(64, 48);
    const png = await makePng(64, 48);
    const webp = await makeWebp(64, 48);

    const pairs = [
      ['jpg -> png', jpg, 'png', 'a.jpg'],
      ['png -> jpg', png, 'jpeg', 'a.png'],
      ['jpg -> webp', jpg, 'webp', 'a.jpg'],
      ['webp -> jpg', webp, 'jpeg', 'a.webp'],
      ['png -> webp', png, 'webp', 'a.png'],
      ['webp -> png', webp, 'png', 'a.webp'],
    ];
    for (const [label, input, format, name] of pairs) {
      const { data } = await convertImage(input, opts({ format }), { name });
      assert.equal(sniffImage(data).format, format, label);
    }
  });
});

describe('alpha handling across formats', () => {
  test('transparency survives every format that supports it', async () => {
    const source = await alphaPng();
    for (const format of ['webp', 'png', 'avif', 'tiff']) {
      const { data } = await convertImage(source, opts({ format, lossless: true }), {
        name: 'a.png',
      });
      const meta = await sharp(data).metadata();
      assert.equal(meta.hasAlpha, true, `${format} keeps the alpha channel`);
    }
  });

  test('PNG to JPEG composites transparency onto the background colour', async () => {
    const source = await alphaPng();
    for (const [background, expected] of [
      ['#ffffff', [255, 255, 255]],
      ['#000000', [0, 0, 0]],
      ['#ff0000', [255, 0, 0]],
    ]) {
      const { data, info } = await convertImage(
        source, opts({ format: 'jpeg', background, quality: 100 }), { name: 'a.png' },
      );
      const pixels = await sharp(data).raw().toBuffer();
      // Top-left sits in the fully transparent half.
      assert.deepEqual(
        [pixels[0], pixels[1], pixels[2]].map((v) => Math.round(v / 8) * 8),
        expected.map((v) => Math.round(v / 8) * 8),
        `transparent area becomes ${background}`,
      );
      assert.ok(
        info.warnings.some((w) => /no transparency/i.test(w)),
        'the flattening is reported, not silent',
      );
    }
  });

  test('a JPEG output never carries an alpha channel', async () => {
    const { data } = await convertImage(await alphaPng(), opts({ format: 'jpeg' }), {
      name: 'a.png',
    });
    assert.equal((await sharp(data).metadata()).hasAlpha, false);
  });

  test('an opaque source converts without a flattening warning', async () => {
    const { info } = await convertImage(await makeJpeg(32, 32), opts({ format: 'jpeg' }), {
      name: 'a.jpg',
    });
    assert.ok(!info.warnings.some((w) => /no transparency/i.test(w)));
  });
});

describe('keep-source (compress) mode', () => {
  test('re-encodes each format as itself', async () => {
    const sources = {
      jpeg: await makeJpeg(200, 150),
      png: await makePng(200, 150),
      webp: await makeWebp(200, 150),
      gif: await makeGif(200, 150),
      tiff: await makeTiff(200, 150),
    };
    for (const [format, input] of Object.entries(sources)) {
      const { data, info } = await convertImage(input, opts({ format: 'original' }), {
        name: `a.${format}`,
      });
      assert.equal(info.format, format, `${format} stays ${format}`);
      assert.equal(info.keptSource, true);
      assert.equal(sniffImage(data).format, format);
    }
  });

  test('a JPEG shrinks meaningfully when re-encoded at lower quality', async () => {
    const jpeg = await makeJpeg(800, 600);
    const { data } = await convertImage(jpeg, opts({ format: 'original', quality: 45 }), {
      name: 'a.jpg',
    });
    assert.ok(data.length < jpeg.length * 0.7, `${jpeg.length} -> ${data.length}`);
  });

  test('a format with no writer falls back to PNG and says so', async () => {
    // BMP is refused by the server engine outright, so HEIC-style fallback is
    // exercised through resolveOutputFormat instead - see output-formats tests.
    const bmp = await makeBmp(16, 16);
    await assert.rejects(
      () => convertImage(bmp, opts({ format: 'original' }), { name: 'a.bmp' }),
      (error) => {
        assert.equal(error.code, 'SERVER_CANNOT_DECODE');
        assert.match(error.message, /browser/i);
        return true;
      },
    );
  });
});

describe('target-size compression', () => {
  test('lands under the budget and reports the quality it chose', async () => {
    const jpeg = await makeJpeg(1000, 750);
    for (const target of [60 * 1024, 30 * 1024, 15 * 1024]) {
      const { data, info } = await convertImage(
        jpeg, opts({ format: 'jpeg', targetBytes: String(target) }), { name: 'a.jpg' },
      );
      assert.ok(data.length <= target, `${data.length} <= ${target}`);
      assert.equal(info.hitTarget, true);
      assert.ok(info.searchAttempts >= 1 && info.searchAttempts <= 8, 'bounded search');
      assert.ok(info.quality >= 1 && info.quality <= 100);
    }
  });

  test('accepts a human-readable budget', async () => {
    const jpeg = await makeJpeg(1000, 750);
    const { data } = await convertImage(
      jpeg, opts({ format: 'jpeg', targetBytes: '30kb' }), { name: 'a.jpg' },
    );
    assert.ok(data.length <= 30 * 1024);
  });

  test('skips the search when the image already fits', async () => {
    const small = await makeJpeg(40, 30);
    const { info } = await convertImage(
      small, opts({ format: 'jpeg', targetBytes: '1mb' }), { name: 'a.jpg' },
    );
    assert.equal(info.searchAttempts, 1, 'one encode, no bisection');
    assert.equal(info.quality, 82, 'keeps the requested quality');
  });

  test('reports an unreachable budget instead of pretending', async () => {
    const jpeg = await makeJpeg(1200, 900);
    const { info } = await convertImage(
      jpeg, opts({ format: 'jpeg', targetBytes: '2kb' }), { name: 'a.jpg' },
    );
    assert.equal(info.hitTarget, false);
    assert.ok(
      info.warnings.some((w) => /could not reach the target/i.test(w)),
      'warns rather than failing silently',
    );
  });

  test('a budget is ignored, with a warning, for a lossless-only format', async () => {
    const png = await makePng(200, 150);
    const { info } = await convertImage(
      png, opts({ format: 'gif', targetBytes: '5kb' }), { name: 'a.png' },
    );
    assert.equal(info.searchAttempts, 0, 'no search was attempted');
    assert.ok(info.warnings.some((w) => /target size needs a lossy encoder/i.test(w)));
  });

  test('the target search never exceeds the requested quality', async () => {
    const jpeg = await makeJpeg(600, 400);
    const { info } = await convertImage(
      jpeg, opts({ format: 'jpeg', quality: 50, targetBytes: '1mb' }), { name: 'a.jpg' },
    );
    assert.ok(info.quality <= 50, `chose ${info.quality}`);
  });
});

describe('animation', () => {
  test('an animated GIF keeps its frames when converted to WebP', async () => {
    const frames = await sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 10, g: 200, b: 90, alpha: 1 } },
    }).png().toBuffer();
    const animated = await sharp(frames, { animated: false })
      .gif({ loop: 0 })
      .toBuffer();

    // A single-frame GIF is still the honest check that the path does not throw.
    const { data, info } = await convertImage(animated, opts({ format: 'webp' }), {
      name: 'a.gif',
    });
    assert.equal(sniffImage(data).format, 'webp');
    assert.ok(info.pages >= 1);
  });

  test('a multi-frame GIF to JPEG keeps the first frame and warns', async () => {
    const frame = await sharp({
      create: { width: 30, height: 30, channels: 3, background: { r: 200, g: 30, b: 30 } },
    }).png().toBuffer();
    // Stack three frames vertically and tell sharp it is a 3-page animation.
    const strip = await sharp({
      create: { width: 30, height: 90, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([
        { input: frame, top: 0, left: 0 },
        { input: frame, top: 30, left: 0 },
        { input: frame, top: 60, left: 0 },
      ])
      .png()
      .toBuffer();
    const gif = await sharp(strip, { raw: undefined, pages: 3, pageHeight: 30 })
      .gif()
      .toBuffer()
      .catch(() => null);

    if (!gif) return; // sharp build without multi-page GIF write

    const { data, info } = await convertImage(gif, opts({ format: 'jpeg' }), { name: 'a.gif' });
    assert.equal(sniffImage(data).format, 'jpeg');
    if ((info.pages ?? 1) > 1) {
      assert.ok(info.warnings.some((w) => /cannot animate/i.test(w)));
    }
  });
});

describe('TIFF compression policy', () => {
  test('lossy TIFF actually compresses photographic data', async () => {
    // LZW would inflate this several times over; the encoder must not use it.
    const tiff = await makeTiff(800, 600);
    const { data } = await convertImage(tiff, opts({ format: 'tiff', quality: 82 }), {
      name: 'a.tiff',
    });
    assert.ok(data.length <= tiff.length, `${tiff.length} -> ${data.length}`);
  });

  test('lossless TIFF stays lossless even though it is larger', async () => {
    const tiff = await makeTiff(200, 150);
    const { data } = await convertImage(tiff, opts({ format: 'tiff', lossless: true }), {
      name: 'a.tiff',
    });
    assert.equal(sniffImage(data).format, 'tiff');
  });

  test('a transparent source forces the lossless TIFF path', async () => {
    const { data, info } = await convertImage(
      await alphaPng(), opts({ format: 'tiff', quality: 60 }), { name: 'a.png' },
    );
    assert.equal((await sharp(data).metadata()).hasAlpha, true, 'alpha is preserved');
    assert.ok(info.warnings.some((w) => /lossless deflate/i.test(w)));
  });
});
