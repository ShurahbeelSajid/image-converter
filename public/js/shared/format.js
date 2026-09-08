/** Small presentation helpers shared by the UI, the CLI and the tests. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Coerce to a number, treating "absent" as unknown rather than zero.
 *
 * `Number(null)` and `Number('')` are both 0, which would render an unknown
 * size as a confident "0 B" instead of admitting it is unknown.
 */
function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  return Number(value);
}

/**
 * Human-readable byte count using binary steps (1 KB = 1024 B).
 * Precision tapers off with magnitude so columns stay narrow.
 */
export function formatBytes(bytes) {
  const n = toNumber(bytes);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n === 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  const value = n / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[exponent]}`;
}

/**
 * Size change as a signed percentage: -72 means the output is 72% smaller.
 * Returns null when there is no meaningful baseline.
 */
export function savingsPercent(originalBytes, resultBytes) {
  const from = toNumber(originalBytes);
  const to = toNumber(resultBytes);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
  return ((to - from) / from) * 100;
}

/** `savingsPercent` rendered for display: "-72%" saved, "+4%" grew. */
export function formatSavings(originalBytes, resultBytes) {
  const pct = savingsPercent(originalBytes, resultBytes);
  if (pct === null) return '-';
  const rounded = Math.abs(pct) < 0.05 ? 0 : pct;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(rounded === 0 ? 0 : 1)}%`;
}

/** Compact elapsed time: "820 ms", "1.4 s", "1m 05s". */
export function formatDuration(ms) {
  const n = toNumber(ms);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** "1920 x 1080", or a dash when the dimensions are unknown. */
export function formatDimensions(width, height) {
  return width && height ? `${width} x ${height}` : '-';
}
