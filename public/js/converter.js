/**
 * Conversion orchestration: a worker pool for local encoding, plus a server
 * engine for formats the browser cannot decode.
 *
 * The pool keeps every core busy without ever blocking the main thread. Workers
 * are spawned lazily on first use and reused for the life of the page, since
 * spawning costs more than most single conversions.
 */

import { INPUT_FORMATS } from './shared/constants.js';
import { KEEP_SOURCE, OUTPUT_FORMATS, qualityApplies } from './shared/output-formats.js';
import { extensionOf } from './shared/signature.js';
import { replaceExtension } from './shared/filename.js';

/** Leave a core for the UI, and cap the pool so memory stays bounded. */
const POOL_SIZE = Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 1, 8));

/** WebP encoding in a worker needs OffscreenCanvas with a 2D context. */
export function supportsLocalEncoding() {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
  try {
    const probe = new OffscreenCanvas(1, 1);
    return typeof probe.convertToBlob === 'function' && probe.getContext('2d') !== null;
  } catch {
    return false;
  }
}

const inputSpecFor = (file) => {
  const ext = extensionOf(file.name);
  return Object.values(INPUT_FORMATS).find((f) => f.ext.includes(ext)) ?? null;
};

/** Can this browser decode the file at all, judging by its extension? */
export function needsServerDecode(file) {
  const spec = inputSpecFor(file);
  return spec ? !spec.canvasDecodable : false;
}

/**
 * True for formats only the browser can read - BMP, which libvips has no
 * loader for. Such a file can still reach a server-only output format, but
 * only by being decoded here first.
 */
export function needsBrowserDecode(file) {
  const spec = inputSpecFor(file);
  return spec ? spec.serverDecodable === false : false;
}

/**
 * Should this job go to the server rather than a worker?
 *
 * Canvas is limited in three ways the server is not: it decodes fewer formats,
 * writes only JPEG/PNG/WebP, and offers no lossless or palette-quantisation
 * control. Each of those is a reason to prefer sharp when it is reachable.
 */
export function needsServerEngine(file, options = {}) {
  if (needsServerDecode(file)) return true;

  const format = options.format;
  if (format && format !== KEEP_SOURCE && OUTPUT_FORMATS[format]?.canvasEncodable === false) {
    return true;
  }
  // Canvas has no lossless mode, and no PNG palette quantisation - a sub-100
  // quality on a PNG simply does nothing in the browser.
  if (options.lossless) return true;
  if (format === 'png' && Number(options.quality) < 100) return true;

  // With "same as source" the real format is unknown until the bytes are
  // sniffed, so the decision is deferred to the worker: it resolves the format
  // and raises FORMAT_NEEDS_SERVER only if that particular one needs sharp.
  // Deciding here instead would send every compress job to the server,
  // including JPEG and WebP, which the worker handles perfectly well.
  if (
    options.targetBytes &&
    format &&
    format !== KEEP_SOURCE &&
    !qualityApplies(format, { engine: 'browser' })
  ) {
    return true;
  }

  return false;
}

class WorkerPool {
  #idle = [];
  #all = [];
  #queue = [];
  #pending = new Map();
  #nextId = 1;

  #spawn() {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event) => {
      const { id, ok, result, error } = event.data;
      const task = this.#pending.get(id);
      if (!task) return;
      this.#pending.delete(id);
      if (ok) task.resolve(result);
      else {
        const err = new Error(error.message);
        err.code = error.code;
        task.reject(err);
      }
      this.#release(worker);
    });
    worker.addEventListener('error', (event) => {
      // A worker-level failure kills whatever it was running; fail that task
      // and retire the worker rather than leaving the promise dangling.
      const entry = [...this.#pending.entries()].find(([, t]) => t.worker === worker);
      if (entry) {
        const [id, task] = entry;
        this.#pending.delete(id);
        task.reject(new Error(event.message || 'Worker crashed.'));
      }
      this.#retire(worker);
    });
    this.#all.push(worker);
    return worker;
  }

  #release(worker) {
    const next = this.#queue.shift();
    if (next) this.#run(worker, next);
    else this.#idle.push(worker);
  }

  #retire(worker) {
    worker.terminate();
    this.#all = this.#all.filter((w) => w !== worker);
    this.#idle = this.#idle.filter((w) => w !== worker);
    // Keep the queue moving even after a crash.
    if (this.#queue.length > 0 && this.#all.length < POOL_SIZE) {
      this.#release(this.#spawn());
    }
  }

  #run(worker, task) {
    task.worker = worker;
    this.#pending.set(task.id, task);
    worker.postMessage({ id: task.id, file: task.file, options: task.options });
  }

  /** @returns {Promise<object>} Resolves with the worker's encode result. */
  submit(file, options) {
    return new Promise((resolve, reject) => {
      const task = { id: this.#nextId++, file, options, resolve, reject };
      const worker = this.#idle.pop() ?? (this.#all.length < POOL_SIZE ? this.#spawn() : null);
      if (worker) this.#run(worker, task);
      else this.#queue.push(task);
    });
  }

  /** Drop queued work and tear down every worker. */
  dispose() {
    for (const task of this.#queue) task.reject(new DOMException('Cancelled', 'AbortError'));
    for (const task of this.#pending.values()) {
      task.reject(new DOMException('Cancelled', 'AbortError'));
    }
    this.#queue = [];
    this.#pending.clear();
    for (const worker of this.#all) worker.terminate();
    this.#all = [];
    this.#idle = [];
  }
}

let pool = null;
const getPool = () => (pool ??= new WorkerPool());

/** Cancel everything in flight and reset the pool. */
export function cancelAll() {
  pool?.dispose();
  pool = null;
}

/** Encode locally, in a pooled worker. */
export function convertLocally(file, options) {
  return getPool().submit(file, options);
}

/**
 * Encode on the server via sharp. The body is the raw file - no multipart
 * framing to parse on either end, which keeps large uploads cheap.
 */
export async function convertOnServer(file, options, signal) {
  const startedAt = performance.now();
  const params = new URLSearchParams({
    format: String(options.format),
    quality: String(options.quality),
    effort: String(options.effort),
    lossless: String(Boolean(options.lossless)),
    keepMetadata: String(Boolean(options.keepMetadata)),
    background: String(options.background),
  });
  if (options.maxWidth) params.set('maxWidth', String(options.maxWidth));
  if (options.maxHeight) params.set('maxHeight', String(options.maxHeight));
  if (options.targetBytes) params.set('targetBytes', String(options.targetBytes));

  const response = await fetch(`/api/convert?${params}`, {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name),
    },
    body: file,
    signal,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const error = new Error(detail?.error ?? `Server returned ${response.status}.`);
    error.code = detail?.code ?? 'SERVER_ERROR';
    throw error;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const meta = JSON.parse(response.headers.get('x-image-meta') ?? '{}');
  return {
    bytes,
    width: meta.width ?? null,
    height: meta.height ?? null,
    sourceWidth: meta.sourceWidth ?? null,
    sourceHeight: meta.sourceHeight ?? null,
    resized: Boolean(meta.resized),
    format: meta.format ?? null,
    sourceFormat: meta.sourceFormat ?? null,
    keptSource: Boolean(meta.keptSource),
    quality: meta.quality ?? options.quality,
    searchAttempts: meta.searchAttempts ?? 0,
    hitTarget: meta.hitTarget ?? null,
    warnings: meta.warnings ?? [],
    ms: performance.now() - startedAt,
  };
}

/** Is the sharp-backed API reachable from this page? */
export async function probeServer() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Convert with the requested engine, falling back when that engine cannot
 * handle the file.
 *
 * @param {File} file
 * @param {object} options Normalised encoder options.
 * @param {{engine?: 'auto'|'browser'|'server', serverAvailable?: boolean,
 *          signal?: AbortSignal}} context
 */
export async function convert(file, options, context = {}) {
  const { engine = 'auto', serverAvailable = false, signal } = context;
  const localOk = supportsLocalEncoding();

  // `needsServerEngine` already covers the cases canvas cannot do justice to:
  // undecodable inputs, unwritable outputs, lossless, and PNG quantisation.
  const useServer =
    engine === 'server' ||
    (engine === 'auto' && serverAvailable && (needsServerEngine(file, options) || !localOk));

  if (useServer) {
    if (!serverAvailable && engine === 'server') {
      const error = new Error('Server engine is not reachable - start it with `npm start`.');
      error.code = 'SERVER_UNAVAILABLE';
      throw error;
    }

    // BMP in, AVIF out: neither engine can do the whole job alone. Decode here
    // to a lossless PNG and let sharp finish, so no quality is lost in the
    // hand-off and the combination stops being a dead end.
    if (needsBrowserDecode(file) && localOk) {
      const bridge = await convertLocally(file, {
        ...options,
        format: 'png',
        lossless: true,
        quality: 100,
        targetBytes: null,
        maxWidth: null,
        maxHeight: null,
      });
      const asPng = new File([bridge.bytes], replaceExtension(file.name, 'png'), {
        type: 'image/png',
      });
      const result = await convertOnServer(asPng, options, signal);
      return {
        ...result,
        // Report the true source, not the intermediate.
        sourceFormat: bridge.sourceFormat ?? result.sourceFormat,
        warnings: [...(bridge.warnings ?? []), ...(result.warnings ?? [])],
        engine: 'browser+server',
      };
    }

    return { ...(await convertOnServer(file, options, signal)), engine: 'server' };
  }

  if (!localOk) {
    const error = new Error(
      'This browser cannot encode images locally. Start the server and pick the server engine.',
    );
    error.code = 'LOCAL_UNSUPPORTED';
    throw error;
  }

  try {
    const serverFallbackAvailable = engine === 'auto' && serverAvailable;
    return {
      ...(await convertLocally(file, { ...options, serverFallbackAvailable })),
      engine: 'browser',
    };
  } catch (error) {
    // A local decode miss is recoverable when the server is up: retry there
    // rather than surfacing a dead end to the user.
    const recoverable =
      error.code === 'DECODE_FAILED' ||
      error.code === 'FORMAT_NEEDS_SERVER' ||
      error.code === 'WEBP_UNSUPPORTED';
    if (engine === 'auto' && serverAvailable && recoverable) {
      return { ...(await convertOnServer(file, options, signal)), engine: 'server' };
    }
    throw error;
  }
}
