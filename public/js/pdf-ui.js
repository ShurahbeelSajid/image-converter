/**
 * PDF view controller: "Images -> PDF" and "PDF -> Images".
 *
 * Owns its own panel, queue and result lists, so the image converter's flow in
 * app.js is untouched - app.js only switches views and routes dropped files
 * here. As there, every object URL is tracked per row and revoked with it.
 */

import {
  INPUT_FORMATS, MAX_BATCH_FILES, MAX_BATCH_UPLOAD_BYTES, MAX_FILE_BYTES,
} from './shared/constants.js';
import { SNIFF_BYTES } from './shared/signature.js';
import { validateFile } from './shared/validation.js';
import { mimeOf, OUTPUT_FORMATS, qualityApplies } from './shared/output-formats.js';
import {
  normalisePdfOptions, normalisePdfRenderOptions, PAGE_SIZES, pdfFileName, sniffPdf,
} from './shared/pdf.js';
import { uniqueName } from './shared/filename.js';
import { formatBytes, formatDimensions, formatDuration } from './shared/format.js';
import { createZip } from './shared/zip.js';
import { imagesToPdf, pdfToImages } from './pdf-client.js';

const $ = (id) => document.getElementById(id);

const els = {
  toControls: $('to-pdf-controls'),
  fromControls: $('from-pdf-controls'),
  pageSize: $('pdf-page-size'),
  orientation: $('pdf-orientation'),
  margin: $('pdf-margin'),
  images: $('pdf-images'),
  quality: $('pdf-quality'),
  qualityValue: $('pdf-quality-value'),
  background: $('pdf-background'),
  backgroundControl: $('pdf-background-control'),
  renderFormat: $('render-format'),
  renderDpi: $('render-dpi'),
  renderPages: $('render-pages'),
  renderQuality: $('render-quality'),
  renderQualityValue: $('render-quality-value'),
  renderBackground: $('render-background'),
  error: $('pdf-error'),
  queuePanel: $('pdf-queue-panel'),
  queueCount: $('pdf-queue-count'),
  queue: $('pdf-queue'),
  create: $('pdf-create'),
  queueClear: $('pdf-queue-clear'),
  output: $('pdf-output'),
  summary: $('pdf-summary'),
  statPages: $('pdf-stat-pages'),
  statBefore: $('pdf-stat-before'),
  statAfter: $('pdf-stat-after'),
  statTime: $('pdf-stat-time'),
  downloadAll: $('pdf-download-all'),
  clear: $('pdf-clear'),
  progress: $('pdf-progress'),
  progressBar: $('pdf-progress-bar'),
  results: $('pdf-results'),
  resultTemplate: $('result-template'),
  queueTemplate: $('queue-item-template'),
};

/** Shown in place of a thumbnail the browser cannot decode (TIFF, HEIC). */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const SERVER_NEEDED =
  'The PDF tools run in the server engine, which is not reachable. ' +
  'Start Image Forge with start.bat (or `npm start`) and reload this page.';
const RENDER_UNAVAILABLE =
  'This server cannot render PDFs - its canvas module did not load. ' +
  'Run `npm run doctor` in the project folder for details.';

let mode = 'to-pdf';
let setStatus = () => {};
let server = {
  available: false,
  render: false,
  maxUploadBytes: MAX_FILE_BYTES,
  maxBatchUploadBytes: MAX_BATCH_UPLOAD_BYTES,
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function showError(message) {
  els.error.textContent = message ?? '';
  els.error.hidden = !message;
}

/* ------------------------------------------------------------ result rows */

/** A row from the shared result template, showing a single thumbnail. */
function createRow(list, name) {
  const node = els.resultTemplate.content.firstElementChild.cloneNode(true);
  node.classList.add('is-single');
  const row = {
    node,
    urls: [],
    els: {
      thumb: node.querySelector('.thumb-after'),
      tag: node.querySelector('.thumb-tag-after'),
      name: node.querySelector('.result-name'),
      meta: node.querySelector('.result-meta'),
      error: node.querySelector('.result-error'),
      savings: node.querySelector('.savings-value'),
      sizes: node.querySelector('.savings-sizes'),
      download: node.querySelector('.btn-download'),
      spinner: node.querySelector('.spinner'),
    },
  };
  row.els.name.textContent = name;
  row.els.name.title = name;
  list.append(node);
  return row;
}

function trackUrl(row, blob) {
  const url = URL.createObjectURL(blob);
  row.urls.push(url);
  return url;
}

function disposeRow(row) {
  if (!row) return;
  for (const url of row.urls) URL.revokeObjectURL(url);
  row.urls.length = 0;
  row.node.remove();
}

/** Point the row's thumbnail at `blob`, if this browser can display it. */
function setThumb(row, blob, displayable, label) {
  row.els.thumb.src = displayable ? trackUrl(row, blob) : BLANK;
  row.els.tag.textContent = label;
}

function finishRow(row, { url, downloadName, meta, size, sizes, warnings }) {
  row.els.spinner.hidden = true;
  row.els.download.href = url;
  row.els.download.download = downloadName;
  row.els.download.hidden = false;
  row.els.meta.textContent = meta;
  row.els.savings.textContent = size;
  row.els.sizes.textContent = sizes ?? '';
  if (warnings?.length) {
    row.els.error.textContent = warnings.join(' ');
    row.els.error.classList.add('is-warning');
    row.els.error.hidden = false;
  }
}

function failRow(row, error, meta = '') {
  row.node.classList.add('is-error');
  row.els.spinner.hidden = true;
  row.els.meta.textContent = meta;
  row.els.error.textContent = error.message;
  row.els.error.classList.remove('is-warning');
  row.els.error.hidden = false;
  row.els.savings.textContent = 'failed';
  row.els.savings.classList.add('is-worse');
}

/* ---------------------------------------------------------- images -> PDF */

/** Page order for the PDF: { id, file, format, url, node }. */
let queue = [];
let nextId = 1;
let building = null; // AbortController while a PDF is being built
let outputRow = null;

function readPdfOptions() {
  return normalisePdfOptions({
    pageSize: els.pageSize.value,
    orientation: els.orientation.value,
    margin: els.margin.value,
    compress: els.images.value === 'compress',
    quality: els.quality.value,
    background: els.background.value,
  });
}

function renderQueue() {
  els.queuePanel.hidden = queue.length === 0;
  els.queueCount.textContent = plural(queue.length, 'image');
  queue.forEach((item, index) => {
    // Re-appending in order moves nodes without recreating them.
    els.queue.append(item.node);
    item.node.querySelector('.queue-index').textContent = String(index + 1);
    item.node.querySelector('[data-move="-1"]').disabled = index === 0;
    item.node.querySelector('[data-move="1"]').disabled = index === queue.length - 1;
  });
  els.create.disabled = queue.length === 0 || building !== null;
}

function addQueueItem(file, detected) {
  const node = els.queueTemplate.content.firstElementChild.cloneNode(true);
  const displayable = INPUT_FORMATS[detected.format]?.canvasDecodable === true;
  const item = {
    id: nextId++,
    file,
    format: detected.format,
    url: displayable ? URL.createObjectURL(file) : null,
    node,
  };
  node.dataset.id = String(item.id);

  const thumb = node.querySelector('.thumb-img');
  thumb.src = item.url ?? BLANK;
  thumb.alt = displayable ? `Preview of ${file.name}` : '';
  node.querySelector('.result-name').textContent = file.name;
  node.querySelector('.result-name').title = file.name;
  node.querySelector('.result-meta').textContent = [
    formatDimensions(detected.width, detected.height),
    detected.format.toUpperCase(),
    formatBytes(file.size),
  ].filter((part) => part !== '-').join(' - ');

  node.querySelector('[data-move="-1"]').setAttribute('aria-label', `Move ${file.name} up`);
  node.querySelector('[data-move="1"]').setAttribute('aria-label', `Move ${file.name} down`);
  node.querySelector('[data-remove]').setAttribute('aria-label', `Remove ${file.name}`);
  queue.push(item);
}

function removeQueueItem(item) {
  if (item.url) URL.revokeObjectURL(item.url);
  item.node.remove();
  queue = queue.filter((entry) => entry !== item);
}

async function queueImages(files) {
  const problems = [];
  for (const file of files) {
    if (queue.length >= MAX_BATCH_FILES) {
      problems.push(`One PDF takes up to ${MAX_BATCH_FILES} images.`);
      break;
    }
    // Judged by the bytes, exactly as the converter does: a PDF dropped here
    // is told where it belongs rather than failing on the server.
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    const verdict = validateFile(file, head);
    if (!verdict.valid) {
      problems.push(`${file.name}: ${verdict.errors[0].message}`);
      continue;
    }
    addQueueItem(file, verdict.detected);
  }
  renderQueue();
  showError(problems.join(' '));
  if (queue.length > 0) setStatus(`${plural(queue.length, 'image')} ready to become a PDF.`);
}

async function createPdf() {
  if (queue.length === 0 || building) return;
  if (!server.available) {
    showError(SERVER_NEEDED);
    return;
  }
  const { options, errors } = readPdfOptions();
  if (errors.length > 0) {
    showError(errors[0].message);
    return;
  }
  const total = queue.reduce((sum, item) => sum + item.file.size, 0);
  if (total > server.maxBatchUploadBytes) {
    showError(`These images total ${formatBytes(total)} - one PDF takes up to ` +
      `${formatBytes(server.maxBatchUploadBytes)}.`);
    return;
  }
  showError('');

  // Each build replaces the last: the queue is still there to tweak and retry.
  disposeRow(outputRow);
  const first = queue[0];
  const row = createRow(els.output, pdfFileName(first.file.name, options.title));
  outputRow = row;
  setThumb(row, first.file, first.url !== null, 'PDF');
  row.els.meta.textContent = `Building from ${plural(queue.length, 'image')}...`;

  building = new AbortController();
  els.create.textContent = 'Creating...';
  renderQueue();
  setStatus(`Creating a PDF from ${plural(queue.length, 'image')}.`);

  const startedAt = performance.now();
  try {
    const { bytes, meta } = await imagesToPdf(
      queue.map(({ file, format }) => ({ file, format })),
      options,
      building.signal,
    );
    const url = trackUrl(row, new Blob([bytes], { type: 'application/pdf' }));
    const name = meta.name ?? pdfFileName(first.file.name, options.title);
    const layout = options.pageSize === 'fit' ? 'pages fit each image' : PAGE_SIZES[options.pageSize].label;
    row.els.name.textContent = name;
    finishRow(row, {
      url,
      downloadName: name,
      meta: [
        plural(meta.pages ?? queue.length, 'page'),
        layout,
        options.compress ? `JPEG quality ${options.quality}` : 'original quality',
        formatDuration(performance.now() - startedAt),
      ].join(' - '),
      size: formatBytes(bytes.length),
      sizes: meta.sourceBytes ? `from ${formatBytes(meta.sourceBytes)}` : '',
      warnings: meta.warnings,
    });
    setStatus(`Created ${name} with ${plural(meta.pages ?? queue.length, 'page')}.`);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    failRow(row, error, plural(queue.length, 'image'));
    setStatus('Creating the PDF failed.');
  } finally {
    building = null;
    els.create.textContent = 'Create PDF';
    renderQueue();
  }
}

function clearQueue() {
  building?.abort();
  for (const item of [...queue]) removeQueueItem(item);
  disposeRow(outputRow);
  outputRow = null;
  renderQueue();
  showError('');
  setStatus('Cleared.');
}

/* ---------------------------------------------------------- PDF -> images */

/** Rendered pages: { row, name, bytes }. */
let pages = [];
/** Download names claimed this session, lowercased. */
const takenNames = new Set();
let rendering = new AbortController();
let jobsTotal = 0;
let jobsDone = 0;
let pdfBytes = 0;
let batchStartedAt = 0;

function readRenderOptions() {
  const format = els.renderFormat.value;
  return normalisePdfRenderOptions({
    format,
    dpi: els.renderDpi.value,
    pages: els.renderPages.value,
    // Left unset for PNG and GIF, which then stay lossless.
    quality: qualityApplies(format, { engine: 'browser' }) ? els.renderQuality.value : undefined,
    background: els.renderBackground.value,
  });
}

function updateRenderSummary() {
  els.summary.hidden = pages.length === 0 && jobsTotal === 0;
  els.statPages.textContent = String(pages.length);
  els.statBefore.textContent = formatBytes(pdfBytes);
  els.statAfter.textContent = formatBytes(pages.reduce((sum, page) => sum + page.bytes.length, 0));
  els.downloadAll.disabled = pages.length === 0;
  els.progress.hidden = jobsTotal === 0 || jobsDone === jobsTotal;
  els.progressBar.style.width = jobsTotal ? `${(jobsDone / jobsTotal) * 100}%` : '0';
}

function addPageRow(page, pageCount, options) {
  const row = createRow(els.results, page.name);
  const name = uniqueName(page.name, takenNames);
  const blob = new Blob([page.bytes], { type: mimeOf(options.format) ?? 'application/octet-stream' });
  const url = trackUrl(row, blob);
  // Every output format but TIFF displays in an <img>.
  const label = OUTPUT_FORMATS[options.format]?.label ?? options.format;
  row.els.thumb.src = options.format === 'tiff' ? BLANK : url;
  row.els.thumb.alt = `Page ${page.page}`;
  row.els.tag.textContent = label;
  finishRow(row, {
    url,
    downloadName: name,
    meta: [
      `Page ${page.page} of ${pageCount}`,
      page.width && page.height ? `${page.width}x${page.height}` : null,
      label,
    ].filter(Boolean).join(' - '),
    size: formatBytes(page.bytes.length),
  });
  pages.push({ row, name, bytes: page.bytes });
  return row;
}

async function renderPdfs(files) {
  if (!server.available) {
    showError(SERVER_NEEDED);
    return;
  }
  if (!server.render) {
    showError(RENDER_UNAVAILABLE);
    return;
  }
  const { options, errors } = readRenderOptions();
  if (errors.length > 0) {
    showError(errors[0].message);
    return;
  }

  const accepted = [];
  const problems = [];
  for (const file of files) {
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    if (!sniffPdf(head).isPdf) {
      problems.push(`${file.name} is not a PDF - images belong in Convert or Images -> PDF.`);
    } else if (file.size > server.maxUploadBytes) {
      problems.push(`${file.name} is ${formatBytes(file.size)} - the limit is ` +
        `${formatBytes(server.maxUploadBytes)}.`);
    } else {
      accepted.push(file);
    }
  }
  showError(problems.join(' '));
  if (accepted.length === 0) return;

  if (jobsDone === jobsTotal) batchStartedAt = performance.now();
  jobsTotal += accepted.length;
  updateRenderSummary();
  const { signal } = rendering;

  // One PDF at a time: each already fans its pages out on the server, and
  // this keeps the server's memory to one document's pages.
  for (const file of accepted) {
    if (signal.aborted) return;
    const placeholder = createRow(els.results, file.name);
    placeholder.els.tag.textContent = 'PDF';
    placeholder.els.thumb.src = BLANK;
    placeholder.els.meta.textContent = `${formatBytes(file.size)} - rendering at ${options.dpi} DPI...`;
    setStatus(`Rendering ${file.name}.`);
    try {
      const result = await pdfToImages(file, options, signal);
      const rows = result.pages.map((page) => addPageRow(page, result.meta.pageCount, options));
      // The pages slot in where the placeholder stood.
      placeholder.node.replaceWith(...rows.map((row) => row.node));
      disposeRow(placeholder);
      if (rows.length > 0 && result.meta.warnings?.length) {
        rows[0].els.error.textContent = result.meta.warnings.join(' ');
        rows[0].els.error.classList.add('is-warning');
        rows[0].els.error.hidden = false;
      }
      pdfBytes += file.size;
      setStatus(`Rendered ${plural(rows.length, 'page')} of ${file.name}.`);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      failRow(placeholder, error, formatBytes(file.size));
      setStatus(`Could not render ${file.name}.`);
    } finally {
      if (!signal.aborted) {
        jobsDone += 1;
        if (jobsDone === jobsTotal) {
          els.statTime.textContent = formatDuration(performance.now() - batchStartedAt);
        }
        updateRenderSummary();
      }
    }
  }
}

function downloadAllPages() {
  if (pages.length === 0) return;
  try {
    const now = new Date();
    const zip = createZip(pages.map((page) => ({ name: page.name, data: page.bytes, date: now })));
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `image-forge-${pages.length}-pages.zip`;
    link.click();
    // As in app.js: the click is already dispatched, so free the archive.
    requestAnimationFrame(() => URL.revokeObjectURL(url));
    setStatus(`Downloading ${plural(pages.length, 'page')} as a ZIP archive.`);
  } catch (error) {
    showError(error.message);
  }
}

function clearPages() {
  rendering.abort();
  rendering = new AbortController();
  for (const page of pages) disposeRow(page.row);
  // Placeholders and failed rows are not in `pages`; the list holds them all.
  els.results.replaceChildren();
  pages = [];
  takenNames.clear();
  jobsTotal = 0;
  jobsDone = 0;
  pdfBytes = 0;
  els.statTime.textContent = '-';
  updateRenderSummary();
  showError('');
  setStatus('Cleared.');
}

/* --------------------------------------------------------------- controls */

function syncControls() {
  const compress = els.images.value === 'compress';
  els.quality.disabled = !compress;
  els.backgroundControl.hidden = !compress;
  els.renderQuality.disabled = !qualityApplies(els.renderFormat.value, { engine: 'browser' });
}

/* ------------------------------------------------------------------ API */

/**
 * Wire up the view. `setStatus` is the page's screen-reader announcer.
 * @returns {{setMode: Function, addFiles: Function, setServer: Function}}
 */
export function initPdfView(hooks = {}) {
  setStatus = hooks.setStatus ?? setStatus;

  els.quality.addEventListener('input', () => {
    els.qualityValue.textContent = els.quality.value;
  });
  els.renderQuality.addEventListener('input', () => {
    els.renderQualityValue.textContent = els.renderQuality.value;
  });
  els.images.addEventListener('change', syncControls);
  els.renderFormat.addEventListener('change', syncControls);

  els.queue.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    const item = queue.find((entry) => entry.node.contains(button));
    if (!button || !item) return;
    if (button.hasAttribute('data-remove')) {
      const index = queue.indexOf(item);
      removeQueueItem(item);
      renderQueue();
      // Focus would otherwise fall back to the page: hand it to the neighbour,
      // or to the drop zone once the queue (and its panel) is gone.
      const next = queue[Math.min(index, queue.length - 1)];
      (next?.node.querySelector('[data-remove]') ?? $('dropzone')).focus();
      return;
    }

    const from = queue.indexOf(item);
    const to = from + Number(button.dataset.move);
    if (to < 0 || to >= queue.length) return;
    [queue[from], queue[to]] = [queue[to], queue[from]];
    renderQueue();
    // Follow the item with focus, so repeated presses keep moving it; at the
    // top or bottom the pressed arrow disables, so switch to the other one.
    const other = item.node.querySelector(`[data-move="${-Number(button.dataset.move)}"]`);
    (button.disabled ? other : button).focus();
  });

  els.create.addEventListener('click', createPdf);
  els.queueClear.addEventListener('click', clearQueue);
  els.downloadAll.addEventListener('click', downloadAllPages);
  els.clear.addEventListener('click', clearPages);

  window.addEventListener('pagehide', () => {
    for (const item of queue) if (item.url) URL.revokeObjectURL(item.url);
    for (const row of [outputRow, ...pages.map((page) => page.row)]) {
      for (const url of row?.urls ?? []) URL.revokeObjectURL(url);
    }
  });

  syncControls();

  return {
    /** Show the controls and results for 'to-pdf' or 'from-pdf'. */
    setMode(next) {
      mode = next;
      const toPdf = mode === 'to-pdf';
      els.toControls.hidden = !toPdf;
      els.queuePanel.hidden = !toPdf || queue.length === 0;
      els.output.hidden = !toPdf;
      els.fromControls.hidden = toPdf;
      els.results.hidden = toPdf;
      if (toPdf) {
        els.summary.hidden = true;
        els.progress.hidden = true;
      } else {
        updateRenderSummary();
      }
      showError(!server.available ? SERVER_NEEDED : !toPdf && !server.render ? RENDER_UNAVAILABLE : '');
    },

    /** Route dropped or picked files to whichever tool is showing. */
    addFiles(fileList) {
      const files = [...fileList];
      if (files.length === 0) return;
      if (mode === 'to-pdf') queueImages(files);
      else renderPdfs(files);
    },

    /** Record what the server can do, from its health report (or null). */
    setServer(health) {
      server = {
        available: Boolean(health),
        render: Boolean(health?.pdf?.render),
        maxUploadBytes: health?.maxUploadBytes ?? MAX_FILE_BYTES,
        maxBatchUploadBytes: health?.maxBatchUploadBytes ?? MAX_BATCH_UPLOAD_BYTES,
      };
    },
  };
}
