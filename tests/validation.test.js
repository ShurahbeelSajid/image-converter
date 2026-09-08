import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  ErrorCode, fitWithin, normaliseOptions, validateBatch, validateFile,
} from '../public/js/shared/validation.js';
import {
  DEFAULT_BACKGROUND, EFFORT_DEFAULT, MAX_DIMENSION, MAX_FILE_BYTES, QUALITY_DEFAULT,
} from '../public/js/shared/constants.js';
import { DEFAULT_OUTPUT_FORMAT } from '../public/js/shared/output-formats.js';
import { makeJpeg, makePixelBombHeader, makePng, notAnImage } from './helpers/fixtures.js';

const codesOf = (result) => result.errors.map((e) => e.code);

describe('validateFile', () => {
  test('accepts a well-formed image', async () => {
    const png = await makePng(64, 48);
    const result = validateFile({ name: 'ok.png', size: png.length }, png);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.detected.format, 'png');
  });

  test('rejects an empty or sizeless file', () => {
    for (const size of [0, -1, NaN, undefined]) {
      const result = validateFile({ name: 'x.png', size }, null);
      assert.equal(result.valid, false);
      assert.deepEqual(codesOf(result), [ErrorCode.EMPTY_FILE]);
    }
  });

  test('rejects a file over the size limit before reading bytes', () => {
    const result = validateFile({ name: 'huge.jpg', size: MAX_FILE_BYTES + 1 }, null);
    assert.equal(result.valid, false);
    assert.deepEqual(codesOf(result), [ErrorCode.TOO_LARGE]);
    assert.match(result.errors[0].message, /limit is/);
  });

  test('honours a caller-supplied size limit', async () => {
    const png = await makePng(8, 8);
    const result = validateFile({ name: 'a.png', size: png.length }, png, { maxBytes: 10 });
    assert.deepEqual(codesOf(result), [ErrorCode.TOO_LARGE]);
  });

  test('rejects content that is not an image', () => {
    const junk = notAnImage();
    const result = validateFile({ name: 'evil.png', size: junk.length }, junk);
    assert.equal(result.valid, false);
    assert.deepEqual(codesOf(result), [ErrorCode.UNSUPPORTED_TYPE]);
  });

  test('rejects a decompression bomb using only the header', () => {
    const bomb = makePixelBombHeader(60000, 60000);
    const result = validateFile({ name: 'bomb.png', size: 5_000 }, bomb);
    assert.equal(result.valid, false);
    assert.deepEqual(codesOf(result), [ErrorCode.DIMENSIONS_TOO_LARGE]);
  });

  test('rejects an over-budget pixel count even when each side is legal', () => {
    // 19000 x 19000 keeps both sides under MAX_DIMENSION but is 361 MP.
    const bomb = makePixelBombHeader(19_000, 19_000);
    assert.ok(19_000 <= MAX_DIMENSION);
    const result = validateFile({ name: 'wide.png', size: 5_000 }, bomb);
    assert.deepEqual(codesOf(result), [ErrorCode.TOO_MANY_PIXELS]);
  });

  test('metadata-only mode skips the content checks', () => {
    const result = validateFile({ name: 'later.png', size: 1024 }, null);
    assert.equal(result.valid, true);
    assert.equal(result.detected, null);
  });

  test('a mislabelled extension warns but still converts', async () => {
    const jpeg = await makeJpeg(32, 32);
    const result = validateFile({ name: 'actually-a-jpeg.png', size: jpeg.length }, jpeg);
    assert.equal(result.valid, true, 'content is a valid image, so it should pass');
    assert.equal(result.detected.format, 'jpeg');
    assert.match(result.warnings[0], /named \.png/i);
  });

  test('a correct extension produces no warning', async () => {
    const jpeg = await makeJpeg(32, 32);
    for (const name of ['photo.jpg', 'photo.jpeg', 'PHOTO.JPG']) {
      assert.deepEqual(validateFile({ name, size: jpeg.length }, jpeg).warnings, []);
    }
  });

  test('a missing name is tolerated', async () => {
    const png = await makePng(8, 8);
    assert.equal(validateFile({ size: png.length }, png).valid, true);
  });
});

describe('validateBatch', () => {
  test('accepts a normal batch', () => {
    assert.equal(validateBatch([{ size: 1 }, { size: 2 }]).valid, true);
  });

  test('rejects an empty selection', () => {
    for (const input of [[], null, undefined]) {
      const result = validateBatch(input);
      assert.equal(result.valid, false);
      assert.equal(result.errors[0].code, ErrorCode.EMPTY_FILE);
    }
  });

  test('rejects a batch beyond the cap', () => {
    const files = Array.from({ length: 5 }, () => ({ size: 1 }));
    const result = validateBatch(files, { maxFiles: 4 });
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, ErrorCode.BATCH_TOO_LARGE);
  });
});

describe('normaliseOptions', () => {
  test('supplies defaults for an empty input', () => {
    const { options, errors } = normaliseOptions({});
    assert.deepEqual(errors, []);
    assert.deepEqual(options, {
      format: DEFAULT_OUTPUT_FORMAT,
      quality: QUALITY_DEFAULT, effort: EFFORT_DEFAULT, lossless: false,
      keepMetadata: false, maxWidth: null, maxHeight: null,
      background: DEFAULT_BACKGROUND, targetBytes: null,
    });
  });

  test('clamps out-of-range numbers instead of failing', () => {
    assert.equal(normaliseOptions({ quality: 500 }).options.quality, 100);
    assert.equal(normaliseOptions({ quality: -20 }).options.quality, 1);
    assert.equal(normaliseOptions({ effort: 99 }).options.effort, 6);
    assert.equal(normaliseOptions({ effort: -1 }).options.effort, 0);
  });

  test('parses query-string strings, not just numbers', () => {
    const { options } = normaliseOptions({ quality: ' 70 ', effort: '2', maxWidth: '800' });
    assert.equal(options.quality, 70);
    assert.equal(options.effort, 2);
    assert.equal(options.maxWidth, 800);
  });

  test('falls back to the default for unparsable numbers', () => {
    assert.equal(normaliseOptions({ quality: 'abc' }).options.quality, QUALITY_DEFAULT);
    assert.equal(normaliseOptions({ quality: null }).options.quality, QUALITY_DEFAULT);
  });

  test('rounds fractional quality', () => {
    assert.equal(normaliseOptions({ quality: 81.6 }).options.quality, 82);
  });

  test('reads booleans from checkboxes and query strings alike', () => {
    for (const truthy of [true, 'true', '1']) {
      assert.equal(normaliseOptions({ lossless: truthy }).options.lossless, true);
    }
    for (const falsy of [false, 'false', '0', undefined, 'no']) {
      assert.equal(normaliseOptions({ lossless: falsy }).options.lossless, false);
    }
  });

  test('treats blank and "auto" resize fields as unset', () => {
    for (const blank of ['', null, undefined, 'auto']) {
      const { options, errors } = normaliseOptions({ maxWidth: blank });
      assert.equal(options.maxWidth, null);
      assert.deepEqual(errors, []);
    }
  });

  test('reports genuinely invalid resize targets', () => {
    assert.equal(normaliseOptions({ maxWidth: -5 }).errors[0].code, ErrorCode.INVALID_OPTION);
    assert.equal(normaliseOptions({ maxHeight: 0 }).errors[0].code, ErrorCode.INVALID_OPTION);
    assert.equal(normaliseOptions({ maxWidth: 'wide' }).errors[0].code, ErrorCode.INVALID_OPTION);
    assert.match(normaliseOptions({ maxWidth: MAX_DIMENSION + 1 }).errors[0].message, /at most/);
  });
});

describe('fitWithin', () => {
  test('scales down to the limiting axis, preserving aspect ratio', () => {
    assert.deepEqual(fitWithin(1000, 500, 400, null), { width: 400, height: 200 });
    assert.deepEqual(fitWithin(1000, 500, null, 100), { width: 200, height: 100 });
    assert.deepEqual(fitWithin(1000, 500, 400, 100), { width: 200, height: 100 });
  });

  test('never upscales', () => {
    assert.equal(fitWithin(100, 50, 4000, 4000), null);
    assert.equal(fitWithin(100, 50, 100, 50), null, 'exact fit needs no resize');
  });

  test('returns null when no constraint is given', () => {
    assert.equal(fitWithin(100, 50, null, null), null);
  });

  test('returns null for unknown source dimensions', () => {
    assert.equal(fitWithin(0, 0, 100, 100), null);
    assert.equal(fitWithin(null, null, 100, 100), null);
  });

  test('never collapses a thin image to zero pixels', () => {
    const result = fitWithin(10_000, 3, 100, null);
    assert.deepEqual(result, { width: 100, height: 1 });
  });
});

describe('normaliseOptions regressions', () => {
  test('a blank quality field uses the default, not the minimum', () => {
    // Number('') and Number(null) are both 0, which would clamp to quality 1
    // and silently produce the worst possible image.
    for (const blank of ['', '   ', null, undefined]) {
      assert.equal(normaliseOptions({ quality: blank }).options.quality, QUALITY_DEFAULT);
      assert.equal(normaliseOptions({ effort: blank }).options.effort, EFFORT_DEFAULT);
    }
  });

  test('an explicit zero still clamps into range', () => {
    assert.equal(normaliseOptions({ quality: 0 }).options.quality, 1);
    assert.equal(normaliseOptions({ effort: 0 }).options.effort, 0);
  });
});
