/**
 * UI controller.
 *
 * Owns the DOM and the item list; all encoding work is delegated to
 * converter.js. Two things matter for perceived speed: results stream in as
 * each worker finishes rather than waiting for the batch, and every object URL
 * is revoked the moment its node goes away so a long session does not leak.
 */

import { ACCEPT_ATTRIBUTE, MAX_BATCH_FILES } from './shared/constants.js';
import { normaliseOptions, validateBatch } from './shared/validation.js';
import {
  KEEP_SOURCE, mimeOf, needsFlattening, OUTPUT_FORMATS, qualityApplies,
} from './shared/output-formats.js';
import { toOutputName, uniqueName } from './shared/filename.js';
import { formatBytes, formatDuration, formatSavings, savingsPercent } from './shared/format.js';
import { createZip } from './shared/zip.js';
import { cancelAll, convert, probeServer, supportsLocalEncoding } from './converter.js';

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  modeConvert: $('mode-convert'),
  modeCompress: $('mode-compress'),
  modeHint: $('mode-hint'),
  format: $('format'),
  targetSize: $('target-size'),
  background: $('background'),
  backgroundControl: $('background-control'),
  quality: $('quality'),
  qualityValue: $('quality-value'),
  maxWidth: $('max-width'),
  maxHeight: $('max-height'),
  engine: $('engine'),
  lossless: $('lossless'),
  keepMetadata: $('keep-metadata'),
  optionError: $('option-error'),
  summary: $('summary'),
  statCount: $('stat-count'),
  statBefore: $('stat-before'),
  statAfter: $('stat-after'),
  statSaved: $('stat-saved'),
  statTime: $('stat-time'),
  downloadAll: $('download-all'),
  clearAll: $('clear-all'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  results: $('results'),
  status: $('status'),
  engineBadge: $('engine-badge'),
  engineLabel: $('engine-label'),
  template: $('result-template'),
};

/** id -> { file, node, urls, result, error, outputName } */
const items = new Map();
/**
 * Output names reserved this session, lowercased. Held here rather than
 * per-batch because "Same as source" only reveals the real extension once the
 * conversion resolves, so names are claimed at that point, not up front.
 */
const takenNames = new Set();
let nextId = 1;
let serverAvailable = false;
let inFlight = 0;
let batchStartedAt = 0;

els.fileInput.accept = ACCEPT_ATTRIBUTE;

/* ---------------------------------------------------------------- options */

function readOptions() {
  const { options, errors } = normaliseOptions({
    format: els.format.value,
    quality: els.quality.value,
    targetBytes: els.targetSize.value,
    background: els.background.value,
    lossless: els.lossless.checked,
    keepMetadata: els.keepMetadata.checked,
    maxWidth: els.maxWidth.value,
    maxHeight: els.maxHeight.value,
  });
  if (errors.length > 0) {
    els.optionError.textContent = errors[0].message;
    els.optionError.hidden = false;
    return null;
  }
  els.optionError.hidden = true;
  return options;
}

/* ------------------------------------------------------------------- URLs */

/** Track every object URL per item so cleanup cannot miss one. */
function trackUrl(item, blob) {
  const url = URL.createObjectURL(blob);
  item.urls.push(url);
  return url;
}

function disposeItem(item) {
  for (const url of item.urls) URL.revokeObjectURL(url);
  item.urls.length = 0;
  item.node.remove();
}

/* ------------------------------------------------------------------ items */

function createRow(file) {
  const id = nextId++;
  const node = els.template.content.firstElementChild.cloneNode(true);
  const item = {
    id,
    file,
    node,
    urls: [],
    result: null,
    error: null,
    // Filled in once the encoder reports which format it actually produced.
    outputName: null,
    els: {
      before: node.querySelector('.thumb-before'),
      after: node.querySelector('.thumb-after'),
      name: node.querySelector('.result-name'),
      meta: node.querySelector('.result-meta'),
      error: node.querySelector('.result-error'),
      savings: node.querySelector('.savings-value'),
      sizes: node.querySelector('.savings-sizes'),
      download: node.querySelector('.btn-download'),
      spinner: node.querySelector('.spinner'),
    },
  };

  item.els.name.textContent = file.name;
  item.els.name.title = file.name;
  item.els.meta.textContent = `${formatBytes(file.size)} - queued`;
  // The source preview can be shown immediately; the browser decodes it for
  // free while the worker is busy encoding.
  item.els.before.src = trackUrl(item, file);
  item.els.before.alt = `Original ${file.name}`;

  items.set(id, item);
  els.results.append(node);
  return item;
}

function renderSuccess(item, result) {
  // The real output format is only known now, so this is where the name is
  // settled and its uniqueness claimed.
  item.outputName = uniqueName(toOutputName(item.file.name, result.format), takenNames);

  const blob = new Blob([result.bytes], { type: mimeOf(result.format) ?? 'application/octet-stream' });
  const url = trackUrl(item, blob);

  item.result = { ...result, bytes: result.bytes, size: result.bytes.length, blob };
  item.els.after.src = url;
  item.els.after.alt = `Converted ${item.outputName}`;
  item.els.download.href = url;
  item.els.download.download = item.outputName;
  item.els.download.hidden = false;
  item.els.spinner.hidden = true;

  // Label the after-thumbnail with what it actually is.
  const tag = item.node.querySelector('.thumb-tag-after');
  if (tag) tag.textContent = OUTPUT_FORMATS[result.format]?.label ?? result.format;

  const from = (result.sourceFormat ?? '').toUpperCase();
  const to = OUTPUT_FORMATS[result.format]?.label ?? String(result.format).toUpperCase();
  const dims = result.width && result.height ? `${result.width}x${result.height}` : '';
  const parts = [
    from && from !== to.toUpperCase() ? `${from} -> ${to}` : to,
    dims,
    result.resized ? `resized from ${result.sourceWidth}x${result.sourceHeight}` : null,
    // When a size budget drove the encode, the quality it settled on is the
    // most interesting number on the row.
    result.searchAttempts ? `quality ${result.quality} in ${result.searchAttempts} tries` : null,
    `${result.engine} engine`,
    formatDuration(result.ms),
  ].filter(Boolean);
  item.els.meta.textContent = parts.join(' - ');

  const pct = savingsPercent(item.file.size, result.bytes.length);
  item.els.savings.textContent = formatSavings(item.file.size, result.bytes.length);
  item.els.savings.classList.toggle('is-worse', pct !== null && pct >= 0);
  item.els.sizes.textContent = `${formatBytes(item.file.size)} -> ${formatBytes(result.bytes.length)}`;

  if (result.warnings?.length) {
    item.els.error.textContent = result.warnings.join(' ');
    item.els.error.classList.add('is-warning');
    item.els.error.hidden = false;
  }
}

function renderFailure(item, error) {
  item.error = error;
  item.node.classList.add('is-error');
  item.els.spinner.hidden = true;
  item.els.meta.textContent = formatBytes(item.file.size);
  item.els.error.textContent = error.message;
  item.els.error.classList.remove('is-warning');
  item.els.error.hidden = false;
  item.els.savings.textContent = 'failed';
  item.els.savings.classList.add('is-worse');
}

/* --------------------------------------------------------------- progress */

/**
 * Progress is derived from the item list rather than per-batch counters, so
 * overlapping batches (files dropped while a conversion is running) can never
 * disagree about the totals.
 */
function updateProgress() {
  const total = items.size;
  const settled = [...items.values()].filter((i) => i.result || i.error).length;
  els.progress.hidden = total === 0 || settled === total;
  els.progressBar.style.width = total ? `${(settled / total) * 100}%` : '0';
}

function updateSummary() {
  const done = [...items.values()].filter((i) => i.result);
  els.summary.hidden = items.size === 0;

  const before = done.reduce((sum, i) => sum + i.file.size, 0);
  const after = done.reduce((sum, i) => sum + i.result.size, 0);

  els.statCount.textContent = `${done.length}/${items.size}`;
  els.statBefore.textContent = formatBytes(before);
  els.statAfter.textContent = formatBytes(after);
  els.statSaved.textContent = done.length ? formatSavings(before, after) : '-';
  els.downloadAll.disabled = done.length === 0;
}

const setStatus = (text) => {
  els.status.textContent = text;
};

/* -------------------------------------------------------------- the batch */

async function addFiles(fileList) {
  const files = [...fileList];
  const batch = validateBatch(files, { maxFiles: MAX_BATCH_FILES });
  if (!batch.valid) {
    els.optionError.textContent = batch.errors[0].message;
    els.optionError.hidden = false;
    return;
  }

  const options = readOptions();
  if (!options) return;

  // The clock starts when the page goes from idle to busy, so dropping a
  // second batch mid-run extends the current timing rather than restarting it.
  if (inFlight === 0) batchStartedAt = performance.now();
  const rows = files.map((file) => createRow(file));

  inFlight += rows.length;
  updateSummary();
  updateProgress();
  setStatus(`Converting ${rows.length} image${rows.length === 1 ? '' : 's'}.`);

  // Hand everything to the pool at once: it keeps every core saturated and
  // results land as they finish rather than in submission order.
  await Promise.all(
    rows.map(async (item) => {
      item.els.meta.textContent = `${formatBytes(item.file.size)} - converting`;
      try {
        const result = await convert(item.file, options, {
          engine: els.engine.value,
          serverAvailable,
        });
        renderSuccess(item, result);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        renderFailure(item, error);
      } finally {
        inFlight -= 1;
        updateProgress();
        updateSummary();
      }
    }),
  );

  // Another batch may still be running (files dropped mid-conversion), so only
  // the last one standing reports the finish.
  if (inFlight > 0) return;

  const elapsed = performance.now() - batchStartedAt;
  els.statTime.textContent = formatDuration(elapsed);
  updateProgress();

  const failed = [...items.values()].filter((i) => i.error).length;
  setStatus(
    failed
      ? `Finished with ${failed} failure${failed === 1 ? '' : 's'}.`
      : `Converted ${items.size} image${items.size === 1 ? '' : 's'} in ${formatDuration(elapsed)}.`,
  );
}

/* ------------------------------------------------------------- downloads */

function downloadAll() {
  const done = [...items.values()].filter((i) => i.result);
  if (done.length === 0) return;

  try {
    const zip = createZip(
      done.map((item) => ({
        name: item.outputName,
        data: item.result.bytes,
        date: new Date(item.file.lastModified || Date.now()),
      })),
    );
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `image-forge-${done.length}-images.zip`;
    link.click();
    // Revoke on the next frame: the click has already been dispatched, and
    // holding the URL any longer keeps the whole archive in memory.
    requestAnimationFrame(() => URL.revokeObjectURL(url));
    setStatus(`Downloading ${done.length} images as a ZIP archive.`);
  } catch (error) {
    els.optionError.textContent = error.message;
    els.optionError.hidden = false;
  }
}

function clearAll() {
  cancelAll();
  for (const item of items.values()) disposeItem(item);
  items.clear();
  takenNames.clear();
  inFlight = 0;
  els.summary.hidden = true;
  els.progress.hidden = true;
  els.statTime.textContent = '-';
  els.fileInput.value = '';
  setStatus('Cleared.');
}

/* ------------------------------------------------------- mode and controls */

/** Server-only outputs: canvas cannot write any of these. */
const SERVER_ONLY_FORMATS = Object.entries(OUTPUT_FORMATS)
  .filter(([, spec]) => !spec.canvasEncodable)
  .map(([name]) => name);

/**
 * Keep the controls honest about what the current selection can actually do,
 * rather than offering settings that will be silently ignored.
 */
function syncControls() {
  const format = els.format.value;
  const compressing = format === KEEP_SOURCE;

  // A background colour only matters when the target cannot store alpha.
  // "Same as source" might still land on JPEG, so keep it available there.
  els.backgroundControl.hidden = !(compressing || needsFlattening(format));

  // Lossless overrides quality, and a size budget needs a lossy encoder.
  const losslessOn = els.lossless.checked;
  els.quality.disabled = losslessOn;
  els.targetSize.disabled = losslessOn;

  // GIF is palette-based and PNG is lossless in the browser: quality is inert.
  const lossyAnywhere = compressing || qualityApplies(format, { engine: 'server' });
  if (!lossyAnywhere) {
    els.quality.disabled = true;
    els.targetSize.disabled = true;
  }

  // Formats only sharp can write are unusable without a reachable server.
  for (const name of SERVER_ONLY_FORMATS) {
    const option = els.format.querySelector(`option[value="${name}"]`);
    if (option) {
      option.disabled = !serverAvailable;
      option.textContent = option.textContent.replace(/ \(server\)$/, '') +
        (serverAvailable ? '' : ' (server)');
    }
  }
}

function setMode(mode) {
  const compressing = mode === 'compress';
  els.modeConvert.classList.toggle('is-active', !compressing);
  els.modeCompress.classList.toggle('is-active', compressing);
  els.modeConvert.setAttribute('aria-selected', String(!compressing));
  els.modeCompress.setAttribute('aria-selected', String(compressing));

  if (compressing) {
    els.format.value = KEEP_SOURCE;
    els.modeHint.textContent =
      'Re-encode in the same format, smaller. Set a target size to hit a budget.';
  } else if (els.format.value === KEEP_SOURCE) {
    els.format.value = 'webp';
    els.modeHint.textContent =
      'Change format - JPG, PNG, WebP, AVIF, GIF, TIFF, any direction.';
  }
  syncControls();
}

/* ---------------------------------------------------------------- events */

els.quality.addEventListener('input', () => {
  els.qualityValue.textContent = els.quality.value;
});

els.lossless.addEventListener('change', syncControls);
els.format.addEventListener('change', () => {
  // Picking a concrete format is itself a switch out of compress mode.
  setMode(els.format.value === KEEP_SOURCE ? 'compress' : 'convert');
});
els.modeConvert.addEventListener('click', () => setMode('convert'));
els.modeCompress.addEventListener('click', () => setMode('compress'));

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    els.fileInput.click();
  }
});

els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files?.length) addFiles(els.fileInput.files);
  // Reset so re-picking the same file fires `change` again.
  els.fileInput.value = '';
});

// dragover must be cancelled or the browser navigates to the dropped file.
for (const type of ['dragenter', 'dragover']) {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add('is-dragging');
  });
}
for (const type of ['dragleave', 'dragend']) {
  els.dropzone.addEventListener(type, () => els.dropzone.classList.remove('is-dragging'));
}
els.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  els.dropzone.classList.remove('is-dragging');
  const dropped = event.dataTransfer?.files;
  if (dropped?.length) addFiles(dropped);
});

// A drop anywhere else would otherwise replace the page with the raw image.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

els.downloadAll.addEventListener('click', downloadAll);
els.clearAll.addEventListener('click', clearAll);

// Release every object URL if the page is torn down mid-session.
window.addEventListener('pagehide', () => {
  for (const item of items.values()) {
    for (const url of item.urls) URL.revokeObjectURL(url);
  }
});

/* ------------------------------------------------------------------ boot */

async function init() {
  const local = supportsLocalEncoding();
  serverAvailable = await probeServer();

  const label = local ? 'Local' : serverAvailable ? 'Server' : 'Unavailable';
  els.engineLabel.textContent = serverAvailable && local ? 'Local + server' : label;
  els.engineBadge.classList.toggle('badge-local', local);
  els.engineBadge.classList.toggle('badge-server', !local && serverAvailable);

  if (!local && !serverAvailable) {
    els.optionError.textContent =
      'This browser cannot encode images locally and the server engine is unreachable.';
    els.optionError.hidden = false;
  }

  // Only safe once `serverAvailable` is known: it gates the server-only
  // output formats.
  syncControls();

  // Server-only knobs are meaningless in the browser engine, which exposes
  // quality but no effort budget.
  els.engine.querySelector('option[value="server"]').disabled = !serverAvailable;
}

init();
