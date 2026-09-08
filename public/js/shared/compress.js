/**
 * Target-size compression.
 *
 * Finding the quality that lands just under a size budget is a search, not a
 * formula: the size/quality curve depends entirely on the image. This bisects
 * it in a bounded number of encodes.
 *
 * The search is written against an injected `encode` function rather than any
 * particular encoder, so the identical algorithm drives sharp on the server and
 * canvas in the worker - and can be tested against a synthetic curve with no
 * image decoding at all.
 */

/** Quality floor for an automatic search: below this, artefacts dominate. */
export const SEARCH_MIN_QUALITY = 20;
export const SEARCH_MAX_QUALITY = 100;

/**
 * A bisection needs ceil(log2(range)) probes to pin a quality exactly; 8 covers
 * the full 1-100 span with one probe to spare for the initial full-quality try.
 */
export const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Encode at the highest quality whose output fits within `targetBytes`.
 *
 * @param {(quality: number) => Promise<{size: number, data?: unknown}>} encode
 *   Encodes at a given quality and reports the resulting byte count. Called at
 *   most `maxAttempts` times.
 * @param {{targetBytes: number, minQuality?: number, maxQuality?: number,
 *          maxAttempts?: number}} options
 * @returns {Promise<{quality: number, size: number, data: unknown,
 *                    attempts: number, hitTarget: boolean}>}
 *   `hitTarget` is false when even the lowest allowed quality overshoots; the
 *   smallest result found is returned anyway rather than failing outright, so
 *   the caller always gets a usable image.
 */
export async function encodeToTargetSize(encode, options) {
  const {
    targetBytes,
    minQuality = SEARCH_MIN_QUALITY,
    maxQuality = SEARCH_MAX_QUALITY,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = options ?? {};

  if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
    throw new RangeError('targetBytes must be a positive number.');
  }
  if (minQuality > maxQuality) {
    throw new RangeError('minQuality cannot exceed maxQuality.');
  }

  let attempts = 0;
  // Results are memoised because the fallback path can ask for a quality the
  // search already probed, and an encode is by far the expensive step here.
  const seen = new Map();
  const probe = async (quality) => {
    if (seen.has(quality)) return seen.get(quality);
    attempts += 1;
    const result = { ...(await encode(quality)), quality };
    seen.set(quality, result);
    return result;
  };

  // Most images already fit, so try full quality first and usually stop there.
  const best0 = await probe(maxQuality);
  if (best0.size <= targetBytes) {
    return { ...best0, attempts, hitTarget: true };
  }

  let lo = minQuality;
  let hi = maxQuality - 1;
  let best = null;

  while (lo <= hi && attempts < maxAttempts) {
    const mid = Math.floor((lo + hi) / 2);
    const result = await probe(mid);
    if (result.size <= targetBytes) {
      best = result; // fits - try to spend the headroom on more quality
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best) return { ...best, attempts, hitTarget: true };

  // Nothing fit. Return the smallest we can legitimately produce, and say so.
  const floor = await probe(minQuality);
  const smallest = [...seen.values()].reduce((a, b) => (b.size < a.size ? b : a), floor);
  return { ...smallest, attempts, hitTarget: smallest.size <= targetBytes };
}

/**
 * Parse a human size budget: "200kb", "1.5 MB", "180000".
 * Bare numbers are bytes. Returns null when unparsable or absent.
 */
export function parseTargetSize(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    return Number.isFinite(input) && input > 0 ? Math.round(input) : null;
  }
  const text = String(input).trim().toLowerCase();
  if (text === '') return null;

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m|kib|mib)?$/.exec(text);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const multipliers = { b: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2 };
  // A bare number is bytes; "200kb" is 204800.
  return Math.round(value * (multipliers[match[2] ?? 'b'] ?? 1));
}
