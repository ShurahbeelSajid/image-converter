import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  DEFAULT_MAX_ATTEMPTS, encodeToTargetSize, parseTargetSize, SEARCH_MIN_QUALITY,
} from '../public/js/shared/compress.js';

/**
 * A stand-in for a real encoder: size rises monotonically with quality, which
 * is the only property the search relies on. Testing against this rather than
 * a codec makes the algorithm's behaviour exactly reproducible.
 */
function fakeEncoder({ scale = 100, floor = 500 } = {}) {
  const calls = [];
  const encode = async (quality) => {
    calls.push(quality);
    return { size: floor + quality * scale, marker: `q${quality}` };
  };
  return { encode, calls };
}

describe('encodeToTargetSize', () => {
  test('stops at full quality when it already fits', async () => {
    const { encode, calls } = fakeEncoder();
    const result = await encodeToTargetSize(encode, { targetBytes: 1_000_000 });
    assert.equal(result.quality, 100);
    assert.equal(result.hitTarget, true);
    assert.equal(calls.length, 1, 'no search is needed');
    assert.equal(result.attempts, 1);
  });

  test('finds the highest quality that fits the budget', async () => {
    // size = 500 + q*100, so the largest q with size <= 5500 is q = 50.
    const { encode } = fakeEncoder();
    const result = await encodeToTargetSize(encode, { targetBytes: 5500 });
    assert.equal(result.quality, 50);
    assert.equal(result.size, 5500);
    assert.equal(result.hitTarget, true);
  });

  test('a claimed hit is always genuinely within budget', async () => {
    // 2000 is below the floor encode (q20 -> 2500), so it must report a miss
    // rather than a result that quietly exceeds the budget.
    for (const target of [2000, 3333, 4001, 7777, 9000]) {
      const { encode } = fakeEncoder();
      const result = await encodeToTargetSize(encode, { targetBytes: target });
      if (result.hitTarget) {
        assert.ok(result.size <= target, `q${result.quality} = ${result.size} <= ${target}`);
      } else {
        assert.ok(result.size > target, 'a miss is only reported when nothing fit');
      }
    }
  });

  test('returns the payload from the winning attempt, not just its size', async () => {
    const { encode } = fakeEncoder();
    const result = await encodeToTargetSize(encode, { targetBytes: 5500 });
    assert.equal(result.marker, 'q50', 'carries the encoder payload through');
  });

  test('stays within the attempt budget', async () => {
    const { encode, calls } = fakeEncoder();
    const result = await encodeToTargetSize(encode, { targetBytes: 5500 });
    assert.ok(calls.length <= DEFAULT_MAX_ATTEMPTS, `${calls.length} attempts`);
    assert.equal(result.attempts, calls.length);
  });

  test('honours a tighter attempt budget, still returning something usable', async () => {
    const { encode, calls } = fakeEncoder();
    const result = await encodeToTargetSize(encode, { targetBytes: 5500, maxAttempts: 3 });
    assert.ok(calls.length <= 3, `${calls.length} attempts`);
    assert.ok(result.size <= 5500, 'the result still fits');
  });

  test('reports failure honestly when even the floor overshoots', async () => {
    // Minimum quality 20 gives 500 + 2000 = 2500, well over a 100-byte target.
    const { encode } = fakeEncoder();
    const result = await encodeToTargetSize(encode, { targetBytes: 100 });
    assert.equal(result.hitTarget, false);
    assert.equal(result.quality, SEARCH_MIN_QUALITY, 'falls back to the floor');
    assert.ok(result.size > 100, 'and does not pretend it fits');
  });

  test('respects a caller-supplied quality ceiling', async () => {
    const { encode, calls } = fakeEncoder();
    const result = await encodeToTargetSize(encode, { targetBytes: 1_000_000, maxQuality: 60 });
    assert.equal(result.quality, 60);
    assert.deepEqual(calls, [60], 'never probes above the ceiling');
  });

  test('respects a caller-supplied quality floor', async () => {
    const { encode, calls } = fakeEncoder();
    await encodeToTargetSize(encode, { targetBytes: 100, minQuality: 40 });
    assert.ok(Math.min(...calls) >= 40, `probed ${calls}`);
  });

  test('never encodes the same quality twice', async () => {
    const { encode, calls } = fakeEncoder();
    await encodeToTargetSize(encode, { targetBytes: 100 });
    assert.equal(new Set(calls).size, calls.length, `duplicate probes in ${calls}`);
  });

  test('rejects a nonsensical budget', async () => {
    const { encode } = fakeEncoder();
    for (const bad of [0, -1, NaN, undefined, null, 'big']) {
      await assert.rejects(
        () => encodeToTargetSize(encode, { targetBytes: bad }),
        /targetBytes must be a positive number/,
      );
    }
    await assert.rejects(
      () => encodeToTargetSize(encode, { targetBytes: 100, minQuality: 90, maxQuality: 10 }),
      /minQuality cannot exceed maxQuality/,
    );
  });

  test('copes with a flat curve where quality changes nothing', async () => {
    // Some inputs barely respond to quality; the search must still terminate.
    const encode = async () => ({ size: 9999 });
    const result = await encodeToTargetSize(encode, { targetBytes: 1000 });
    assert.equal(result.hitTarget, false);
    assert.equal(result.size, 9999);
  });
});

describe('parseTargetSize', () => {
  test('reads a bare number as bytes', () => {
    assert.equal(parseTargetSize('180000'), 180000);
    assert.equal(parseTargetSize(180000), 180000);
    assert.equal(parseTargetSize('500b'), 500);
  });

  test('reads binary units', () => {
    assert.equal(parseTargetSize('200kb'), 200 * 1024);
    assert.equal(parseTargetSize('200KB'), 200 * 1024);
    assert.equal(parseTargetSize('200 kb'), 200 * 1024);
    assert.equal(parseTargetSize('1mb'), 1024 * 1024);
    assert.equal(parseTargetSize('1.5MB'), Math.round(1.5 * 1024 * 1024));
    assert.equal(parseTargetSize('2k'), 2048);
    assert.equal(parseTargetSize('64kib'), 64 * 1024);
  });

  test('returns null for anything unusable', () => {
    for (const bad of ['', '   ', null, undefined, 'big', '12 gigabytes', '-5kb', '0', 'kb', NaN]) {
      assert.equal(parseTargetSize(bad), null, `${JSON.stringify(bad)} should be null`);
    }
  });

  test('always returns a whole number of bytes', () => {
    assert.equal(parseTargetSize('1.3kb'), Math.round(1.3 * 1024));
    assert.ok(Number.isInteger(parseTargetSize('1.7mb')));
  });
});
