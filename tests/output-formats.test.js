import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  DEFAULT_OUTPUT_FORMAT, extOf, isOutputFormat, KEEP_SOURCE, KEEP_SOURCE_FALLBACK,
  mimeOf, needsFlattening, OUTPUT_FORMAT_NAMES, OUTPUT_FORMATS, qualityApplies,
  resolveOutputFormat,
} from '../public/js/shared/output-formats.js';
import { INPUT_FORMATS } from '../public/js/shared/constants.js';

describe('the format table', () => {
  test('every entry declares the full capability set', () => {
    for (const [name, spec] of Object.entries(OUTPUT_FORMATS)) {
      for (const key of ['label', 'mime', 'ext', 'alpha', 'lossy', 'lossless', 'animated', 'canvasEncodable']) {
        assert.ok(key in spec, `${name} is missing "${key}"`);
      }
      assert.match(spec.mime, /^image\//, `${name} has a plausible MIME type`);
      assert.ok(!spec.ext.startsWith('.'), `${name} extension carries no dot`);
    }
  });

  test('the default output format is a real one', () => {
    assert.ok(isOutputFormat(DEFAULT_OUTPUT_FORMAT));
    assert.ok(isOutputFormat(KEEP_SOURCE_FALLBACK));
  });

  test('every writable format can also be read back in', () => {
    // Otherwise "same as source" could produce a file the tool itself rejects.
    for (const name of OUTPUT_FORMAT_NAMES) {
      assert.ok(INPUT_FORMATS[name], `${name} is writable but not accepted as input`);
    }
  });

  test('the fallback format is lossless, so nothing is silently degraded', () => {
    assert.equal(OUTPUT_FORMATS[KEEP_SOURCE_FALLBACK].lossless, true);
    assert.equal(OUTPUT_FORMATS[KEEP_SOURCE_FALLBACK].alpha, true);
  });

  test('isOutputFormat rejects non-formats', () => {
    for (const bad of ['bmp', 'heic', 'svg', '', null, undefined, 'JPEG', KEEP_SOURCE]) {
      assert.equal(isOutputFormat(bad), false, `${bad} should not be writable`);
    }
  });
});

describe('resolveOutputFormat', () => {
  test('an explicit format wins regardless of the source', () => {
    for (const source of ['jpeg', 'png', 'bmp', null]) {
      const result = resolveOutputFormat('webp', source);
      assert.deepEqual(result, { format: 'webp', keptSource: false, fellBack: false });
    }
  });

  test('"keep source" round-trips a writable source format', () => {
    for (const source of OUTPUT_FORMAT_NAMES) {
      const result = resolveOutputFormat(KEEP_SOURCE, source);
      assert.equal(result.format, source);
      assert.equal(result.keptSource, true);
      assert.equal(result.fellBack, false);
    }
  });

  test('"keep source" falls back to PNG for formats we cannot write', () => {
    // BMP and HEIC decode but have no writer; PNG keeps every pixel.
    for (const source of ['bmp', 'heic', null, 'nonsense']) {
      const result = resolveOutputFormat(KEEP_SOURCE, source);
      assert.equal(result.format, KEEP_SOURCE_FALLBACK, `${source} -> png`);
      assert.equal(result.fellBack, true);
    }
  });

  test('an unknown requested format falls back rather than throwing', () => {
    const result = resolveOutputFormat('jpg2000', 'jpeg');
    assert.equal(result.format, 'jpeg', 'treated as "keep source"');
  });
});

describe('needsFlattening', () => {
  test('is true only for formats without an alpha channel', () => {
    assert.equal(needsFlattening('jpeg'), true);
    for (const name of ['webp', 'png', 'avif', 'gif', 'tiff']) {
      assert.equal(needsFlattening(name), false, `${name} keeps alpha`);
    }
  });

  test('is false for an unknown format rather than throwing', () => {
    assert.equal(needsFlattening('nope'), false);
  });
});

describe('qualityApplies', () => {
  test('lossy formats respond to quality in either engine', () => {
    for (const name of ['webp', 'jpeg', 'avif']) {
      assert.equal(qualityApplies(name, { engine: 'browser' }), true, name);
      assert.equal(qualityApplies(name, { engine: 'server' }), true, name);
    }
  });

  test('PNG responds to quality only on the server, via palette quantisation', () => {
    assert.equal(qualityApplies('png', { engine: 'browser' }), false);
    assert.equal(qualityApplies('png', { engine: 'server' }), true);
  });

  test('GIF ignores quality everywhere', () => {
    assert.equal(qualityApplies('gif', { engine: 'browser' }), false);
    assert.equal(qualityApplies('gif', { engine: 'server' }), false);
  });

  test('an unknown format never claims quality applies', () => {
    assert.equal(qualityApplies('nope', { engine: 'server' }), false);
  });
});

describe('mimeOf / extOf', () => {
  test('map each format to its wire type and extension', () => {
    assert.equal(mimeOf('jpeg'), 'image/jpeg');
    assert.equal(extOf('jpeg'), 'jpg', 'JPEG writes .jpg, not .jpeg');
    assert.equal(mimeOf('webp'), 'image/webp');
    assert.equal(extOf('webp'), 'webp');
  });

  test('return null for unknown formats', () => {
    assert.equal(mimeOf('nope'), null);
    assert.equal(extOf('nope'), null);
  });
});
