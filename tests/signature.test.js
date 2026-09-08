import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { extensionOf, sniffImage } from '../public/js/shared/signature.js';
import {
  makeBmp, makeGif, makeJpeg, makePixelBombHeader, makePng, makeTiff, makeWebp,
  notAnImage, truncatedJpeg,
} from './helpers/fixtures.js';

describe('sniffImage', () => {
  test('identifies every supported raster format from its bytes', async () => {
    const cases = [
      ['jpeg', await makeJpeg(64, 48)],
      ['png', await makePng(64, 48)],
      ['gif', await makeGif(64, 48)],
      ['webp', await makeWebp(64, 48)],
      ['tiff', await makeTiff(64, 48)],
      ['bmp', await makeBmp(16, 16)],
    ];
    for (const [expected, buffer] of cases) {
      const result = sniffImage(buffer);
      assert.equal(result.format, expected, `expected ${expected}`);
      assert.equal(result.supported, true);
    }
  });

  test('reads real dimensions out of the container header', async () => {
    for (const make of [makeJpeg, makePng, makeGif, makeWebp, makeTiff]) {
      const result = sniffImage(await make(120, 90));
      assert.equal(result.width, 120, `width for ${result.format}`);
      assert.equal(result.height, 90, `height for ${result.format}`);
    }
  });

  test('finds the SOF marker past a large EXIF block', async () => {
    // A JPEG with metadata pushes SOF well beyond a fixed offset, so a naive
    // reader that peeks at byte 163 would report nonsense.
    const jpeg = await makeJpeg(200, 100, { mozjpeg: false });
    const padded = Buffer.concat([
      jpeg.subarray(0, 2),
      Buffer.concat([
        Buffer.from([0xff, 0xe1, 0x04, 0x02]), // APP1, length 1026
        Buffer.alloc(1024, 0x20),
      ]),
      jpeg.subarray(2),
    ]);
    const result = sniffImage(padded);
    assert.equal(result.format, 'jpeg');
    assert.deepEqual({ w: result.width, h: result.height }, { w: 200, h: 100 });
  });

  test('only needs the leading bytes, not the whole file', async () => {
    const png = await makePng(300, 200);
    const head = png.subarray(0, 64);
    assert.deepEqual(sniffImage(head), {
      format: 'png', mime: 'image/png', supported: true, width: 300, height: 200,
    });
  });

  test('rejects non-images with an explanation', () => {
    const result = sniffImage(notAnImage());
    assert.equal(result.supported, false);
    assert.equal(result.format, null);
    assert.match(result.reason, /not a supported image/i);
  });

  test('names the format when it is recognised but unusable', () => {
    const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.equal(sniffImage(svg).format, 'svg');
    assert.match(sniffImage(svg).reason, /vector/i);

    const pdf = Buffer.from('%PDF-1.7\n%goo');
    assert.equal(sniffImage(pdf).format, 'pdf');

    const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
    assert.equal(sniffImage(ico).format, 'ico');
  });

  test('a renamed file is judged by its bytes, not its name', async () => {
    // "photo.png" that is really a JPEG must sniff as JPEG.
    assert.equal(sniffImage(await makeJpeg()).format, 'jpeg');
  });

  test('handles empty and undersized input without throwing', () => {
    for (const input of [new Uint8Array(0), new Uint8Array([0xff]), new Uint8Array([0xff, 0xd8])]) {
      const result = sniffImage(input);
      assert.equal(result.supported, false);
      assert.ok(result.reason);
    }
  });

  test('a truncated JPEG still identifies as JPEG', async () => {
    // The signature survives truncation; the decoder is what will reject it.
    assert.equal(sniffImage(await truncatedJpeg()).format, 'jpeg');
  });

  test('accepts an ArrayBuffer as well as a view', async () => {
    const png = await makePng(10, 10);
    const copy = new Uint8Array(png).slice().buffer;
    assert.equal(sniffImage(copy).format, 'png');
  });

  test('reports the declared size of a pixel bomb from its header alone', () => {
    const result = sniffImage(makePixelBombHeader(60000, 60000));
    assert.equal(result.format, 'png');
    assert.equal(result.width, 60000);
    assert.equal(result.height, 60000);
  });

  test('unknown ISO-BMFF brands are refused, known ones accepted', () => {
    const box = (brand) => {
      const buf = Buffer.alloc(32);
      buf.writeUInt32BE(32, 0);
      buf.write('ftyp', 4, 'ascii');
      buf.write(brand, 8, 'ascii');
      return buf;
    };
    assert.equal(sniffImage(box('avif')).format, 'avif');
    assert.equal(sniffImage(box('heic')).format, 'heic');

    const video = sniffImage(box('mp42'));
    assert.equal(video.supported, false);
    assert.match(video.reason, /brand/i);
  });
});

describe('extensionOf', () => {
  test('lowercases and strips the dot', () => {
    assert.equal(extensionOf('Photo.JPEG'), 'jpeg');
    assert.equal(extensionOf('archive.tar.gz'), 'gz');
  });

  test('reads the last path segment only', () => {
    assert.equal(extensionOf('C:\\pics\\holiday.png'), 'png');
    assert.equal(extensionOf('/var/tmp/holiday.png'), 'png');
  });

  test('returns empty string when there is no extension', () => {
    for (const name of ['README', '.gitignore', '', null, undefined]) {
      assert.equal(extensionOf(name), '');
    }
  });
});
