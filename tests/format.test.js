import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  formatBytes, formatDimensions, formatDuration, formatSavings, savingsPercent,
} from '../public/js/shared/format.js';

describe('formatBytes', () => {
  test('uses binary steps with tapering precision', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1024), '1.00 KB');
    assert.equal(formatBytes(1536), '1.50 KB');
    assert.equal(formatBytes(10 * 1024), '10.0 KB');
    assert.equal(formatBytes(100 * 1024), '100 KB');
    assert.equal(formatBytes(1024 ** 2), '1.00 MB');
    assert.equal(formatBytes(1024 ** 3), '1.00 GB');
  });

  test('never reports fractional bytes', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.ok(!formatBytes(999).includes('.'));
  });

  test('saturates at the largest unit rather than inventing one', () => {
    assert.match(formatBytes(1024 ** 6), /TB$/);
  });

  test('renders a dash for meaningless input', () => {
    for (const input of [-1, NaN, null, undefined, 'abc']) {
      assert.equal(formatBytes(input), '-');
    }
  });
});

describe('savingsPercent', () => {
  test('is negative when the file shrank', () => {
    assert.equal(savingsPercent(1000, 250), -75);
    assert.equal(savingsPercent(1000, 1000), 0);
  });

  test('is positive when the file grew', () => {
    assert.equal(savingsPercent(1000, 1200), 20);
  });

  test('returns null without a usable baseline', () => {
    assert.equal(savingsPercent(0, 100), null);
    assert.equal(savingsPercent(NaN, 100), null);
    assert.equal(savingsPercent(100, NaN), null);
  });
});

describe('formatSavings', () => {
  test('signs the result and marks growth explicitly', () => {
    assert.equal(formatSavings(1000, 250), '-75.0%');
    assert.equal(formatSavings(1000, 1200), '+20.0%');
  });

  test('collapses a negligible change to a clean zero', () => {
    assert.equal(formatSavings(1000, 1000), '0%');
    assert.equal(formatSavings(100000, 100010), '0%');
  });

  test('renders a dash when there is nothing to compare', () => {
    assert.equal(formatSavings(0, 10), '-');
  });
});

describe('formatDuration', () => {
  test('switches units as the magnitude grows', () => {
    assert.equal(formatDuration(0), '0 ms');
    assert.equal(formatDuration(820), '820 ms');
    assert.equal(formatDuration(1400), '1.4 s');
    assert.equal(formatDuration(65_000), '1m 05s');
    assert.equal(formatDuration(600_000), '10m 00s');
  });

  test('rejects nonsense', () => {
    for (const input of [-5, NaN, null, 'x']) assert.equal(formatDuration(input), '-');
  });
});

describe('formatDimensions', () => {
  test('joins both axes, or gives up cleanly', () => {
    assert.equal(formatDimensions(1920, 1080), '1920 x 1080');
    assert.equal(formatDimensions(null, 1080), '-');
    assert.equal(formatDimensions(0, 0), '-');
  });
});
