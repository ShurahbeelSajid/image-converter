#!/usr/bin/env node
/**
 * Batch CLI: convert or compress files and whole directories.
 *
 * Work is spread across a bounded pool of concurrent conversions. libvips
 * already threads a single image internally, so the pool is sized to keep the
 * cores busy on small files without thrashing on large ones.
 */

import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { ACCEPTED_EXTENSIONS } from '../public/js/shared/constants.js';
import { SNIFF_BYTES, sniffImage } from '../public/js/shared/signature.js';
import { normaliseOptions } from '../public/js/shared/validation.js';
import { toOutputName, uniqueName } from '../public/js/shared/filename.js';
import { formatBytes, formatDuration, formatSavings } from '../public/js/shared/format.js';
import {
  DEFAULT_OUTPUT_FORMAT, extOf, KEEP_SOURCE, OUTPUT_FORMAT_NAMES, resolveOutputFormat,
} from '../public/js/shared/output-formats.js';
import { convertImage } from '../server/convert.js';

const USAGE = `
  image-forge - convert and compress images

  Usage
    node cli/index.js <input...> [options]

  Input
    One or more files or directories. Directories are scanned for
    ${ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(' ')}

  Options
    -o, --out <dir>       Output directory            (default: alongside input)
    -f, --format <fmt>    ${OUTPUT_FORMAT_NAMES.join(' | ')} | same
                          "same" re-encodes in the source format (compress)
                                                      (default: ${DEFAULT_OUTPUT_FORMAT})
    -t, --target-size <n> Shrink to fit a budget, e.g. 200kb or 180000.
                          Searches for the best quality that fits.
    -q, --quality <1-100> Encoder quality             (default: 82)
    -e, --effort <0-6>    Compression effort          (default: 4)
    -w, --max-width <px>  Fit within width, no upscaling
    -h, --max-height <px> Fit within height, no upscaling
        --lossless        Lossless encoding where the format supports it
        --background <#h> Colour under transparency when the target has no
                          alpha channel, e.g. PNG -> JPG   (default: #ffffff)
        --keep-metadata   Preserve EXIF/ICC
    -r, --recursive       Recurse into subdirectories
    -c, --concurrency <n> Parallel conversions        (default: ${Math.max(1, Math.min(os.cpus().length, 8))})
        --dry-run         List what would be written
        --help            Show this message

  Examples
    node cli/index.js photos/ -o dist/ -q 78 -r
    node cli/index.js hero.png --max-width 1600 --lossless
    node cli/index.js shot.png -f jpeg --background '#ffffff'
    node cli/index.js photo.jpg -f png
    node cli/index.js big/ -f same -t 200kb -o small/     # compress in place
`;

/** Minimal flag parser - enough for this surface, no dependency. */
function parseArgs(argv) {
  const aliases = {
    '-o': '--out', '-q': '--quality', '-e': '--effort',
    '-w': '--max-width', '-h': '--max-height',
    '-r': '--recursive', '-c': '--concurrency',
    '-f': '--format', '-t': '--target-size',
  };
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('-')) {
      flags._.push(raw);
      continue;
    }
    const key = (aliases[raw] ?? raw).replace(/^--/, '');
    if (key === 'recursive' || key === 'lossless' || key === 'keep-metadata' ||
        key === 'dry-run' || key === 'help') {
      flags[key] = true;
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`Option --${key} needs a value.`);
      }
      flags[key] = value;
      i += 1;
    }
  }
  return flags;
}

const isConvertible = (file) =>
  ACCEPTED_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase());

/** Expand inputs into a flat list of convertible file paths. */
async function collect(inputs, recursive) {
  const files = [];
  for (const input of inputs) {
    const info = await stat(input).catch(() => null);
    if (!info) {
      console.warn(`  skip  ${input} (not found)`);
      continue;
    }
    if (info.isFile()) {
      files.push(input);
      continue;
    }
    if (!info.isDirectory()) continue;

    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recursive) await walk(full);
        } else if (entry.isFile() && isConvertible(entry.name)) {
          files.push(full);
        }
      }
    };
    await walk(input);
  }
  return files;
}

/** Run `task` over `jobs`, at most `limit` at a time. */
async function pooled(jobs, limit, task) {
  const results = new Array(jobs.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const index = cursor++;
      results[index] = await task(jobs[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Output format for one file: the requested format, or - for `same` - the
 * format detected from the file's own leading bytes.
 */
async function resolveFormatFor(file, requested) {
  if (requested !== KEEP_SOURCE) return requested;
  let handle;
  try {
    handle = await open(file, 'r');
    const head = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0);
    return resolveOutputFormat(requested, sniffImage(head.subarray(0, bytesRead)).format).format;
  } catch {
    // Unreadable here just means the conversion below will report the error.
    return DEFAULT_OUTPUT_FORMAT;
  } finally {
    await handle?.close();
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help || flags._.length === 0) {
    console.log(USAGE);
    process.exit(flags.help ? 0 : 1);
  }

  const { options, errors } = normaliseOptions({
    format: flags.format,
    quality: flags.quality,
    effort: flags.effort,
    lossless: flags.lossless,
    keepMetadata: flags['keep-metadata'],
    maxWidth: flags['max-width'],
    maxHeight: flags['max-height'],
    background: flags.background,
    targetBytes: flags['target-size'],
  });
  if (errors.length > 0) {
    console.error(`  error  ${errors[0].message}`);
    process.exit(1);
  }

  const files = await collect(flags._, Boolean(flags.recursive));
  if (files.length === 0) {
    console.error('  error  No convertible images found.');
    process.exit(1);
  }

  const concurrency = Math.max(
    1,
    Number(flags.concurrency) || Math.min(os.cpus().length, 8),
  );
  const outDir = flags.out ? path.resolve(flags.out) : null;
  if (outDir && !flags['dry-run']) await mkdir(outDir, { recursive: true });

  const targetLabel = options.format === KEEP_SOURCE
    ? 'source format'
    : (extOf(options.format) ?? options.format).toUpperCase();
  console.log(`\n  ${files.length} image${files.length === 1 ? '' : 's'} -> ${targetLabel}  ` +
    `(quality ${options.quality}${options.lossless ? ', lossless' : ''}, ` +
    `effort ${options.effort}` +
    `${options.targetBytes ? `, target ${formatBytes(options.targetBytes)}` : ''}` +
    `, ${concurrency} parallel)\n`);

  // Reserve output names up front so a flattened directory tree cannot have
  // two "photo.webp" entries silently overwrite each other. With `--format
  // same` the extension depends on each file's real format, so every file's
  // header is sniffed first - a few KB each, not a full decode.
  const taken = new Set();
  const plan = [];
  for (const file of files) {
    const format = await resolveFormatFor(file, options.format);
    const name = toOutputName(path.basename(file), format);
    plan.push({
      file,
      out: outDir
        ? path.join(outDir, uniqueName(name, taken))
        : path.join(path.dirname(file), name),
    });
  }

  if (flags['dry-run']) {
    for (const { file, out } of plan) console.log(`  would write  ${out}  <-  ${file}`);
    return;
  }

  const startedAt = performance.now();
  let totalBefore = 0;
  let totalAfter = 0;
  let failures = 0;

  await pooled(plan, concurrency, async ({ file, out }) => {
    try {
      const input = await readFile(file);
      const { data, info } = await convertImage(input, options, { name: path.basename(file) });
      await writeFile(out, data);
      totalBefore += input.length;
      totalAfter += data.length;
      console.log(
        `  ok    ${path.basename(out).padEnd(34)} ` +
        `${formatBytes(input.length).padStart(9)} -> ${formatBytes(data.length).padStart(9)}  ` +
        `${formatSavings(input.length, data.length).padStart(7)}  ${info.width}x${info.height}`,
      );
    } catch (error) {
      failures += 1;
      console.error(`  fail  ${path.basename(file).padEnd(34)} ${error.message}`);
    }
  });

  const elapsed = performance.now() - startedAt;
  console.log(
    `\n  ${plan.length - failures}/${plan.length} converted in ${formatDuration(elapsed)}  ` +
    `${formatBytes(totalBefore)} -> ${formatBytes(totalAfter)}  ` +
    `(${formatSavings(totalBefore, totalAfter)})\n`,
  );

  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`  error  ${error.message}`);
  process.exit(1);
});
