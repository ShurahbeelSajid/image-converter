#!/usr/bin/env node
/**
 * PDF CLI: bind images into a PDF, or render a PDF's pages as images.
 *
 * A thin shell over server/pdf.js - the same engine the HTTP API runs - so the
 * two cannot disagree about layout, limits or output.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { collect, extensionOfPath, parseArgs } from './common.js';
import { ACCEPTED_EXTENSIONS, PDF_DPI_DEFAULT } from '../public/js/shared/constants.js';
import { uniqueName } from '../public/js/shared/filename.js';
import { formatBytes, formatDuration, formatSavings } from '../public/js/shared/format.js';
import { OUTPUT_FORMAT_NAMES } from '../public/js/shared/output-formats.js';
import {
  normalisePdfOptions, normalisePdfRenderOptions, PAGE_SIZES, pdfFileName,
} from '../public/js/shared/pdf.js';
import { imagesToPdf, pdfToImages } from '../server/pdf.js';

const USAGE = `
  image-forge pdf - images to PDF, and PDF to images

  Usage
    node cli/pdf.js images-to-pdf <image|dir...> [-o out.pdf] [options]
    node cli/pdf.js pdf-to-images <pdf|dir...>   [-o out-dir] [options]

  images-to-pdf     One page per image, in the order given. A directory's
                    images are taken in name order (page2 before page10).
    -o, --out <file>        Output PDF          (default: <first image>.pdf)
    -s, --page-size <size>  ${Object.keys(PAGE_SIZES).join(' | ')}   (default: fit)
        --orientation <o>   auto | portrait | landscape    (default: auto)
    -m, --margin <mm>       Space around each image        (default: 0)
        --compress          Re-encode images as JPEG for a smaller PDF.
                            Without it, JPEGs are embedded untouched and
                            everything else losslessly.
    -q, --quality <1-100>   JPEG quality with --compress   (default: 82)
        --background <#h>   Colour under transparency with --compress
        --title <text>      Document title
    -r, --recursive         Recurse into subdirectories

  pdf-to-images     One image per page, named <pdf>-page-<n>.<ext>
    -o, --out <dir>         Output directory     (default: beside each PDF)
    -f, --format <fmt>      ${OUTPUT_FORMAT_NAMES.join(' | ')}   (default: png)
    -d, --dpi <36-600>      Render resolution              (default: ${PDF_DPI_DEFAULT})
    -p, --pages <range>     e.g. 1-3,5 or 8-               (default: all)
    -q, --quality <1-100>   Encoder quality; PNG stays lossless unless set
    -t, --target-size <n>   Shrink each page to fit a budget, e.g. 200kb
    -w, --max-width <px>    Fit within width, no upscaling
    -h, --max-height <px>   Fit within height, no upscaling
        --background <#h>   Page background                (default: #ffffff)
        --lossless          Lossless encoding where the format supports it
    -r, --recursive         Recurse into subdirectories

        --help              Show this message

  Examples
    node cli/pdf.js images-to-pdf scans/ -o scans.pdf -s a4
    node cli/pdf.js images-to-pdf cover.jpg p1.png p2.png -o book.pdf --compress
    node cli/pdf.js pdf-to-images report.pdf -o pages/ -f jpeg --dpi 200
    node cli/pdf.js pdf-to-images report.pdf --pages 1-3 -f webp
`;

const ARG_SPEC = {
  aliases: {
    '-o': '--out', '-s': '--page-size', '-m': '--margin', '-q': '--quality',
    '-r': '--recursive', '-f': '--format', '-d': '--dpi', '-p': '--pages',
    '-t': '--target-size', '-w': '--max-width', '-h': '--max-height',
  },
  booleans: ['recursive', 'compress', 'lossless', 'help'],
};

const fail = (message) => {
  console.error(`  error  ${message}`);
  process.exit(1);
};

const printWarnings = (warnings) => {
  for (const warning of warnings) console.log(`  note  ${warning}`);
};

async function runImagesToPdf(flags) {
  const { options, errors } = normalisePdfOptions({
    pageSize: flags['page-size'],
    orientation: flags.orientation,
    margin: flags.margin,
    compress: flags.compress,
    quality: flags.quality,
    background: flags.background,
    title: flags.title,
  });
  if (errors.length > 0) fail(errors[0].message);

  const files = await collect(flags._, {
    recursive: Boolean(flags.recursive),
    accept: (name) => ACCEPTED_EXTENSIONS.includes(extensionOfPath(name)),
  });
  if (files.length === 0) fail('No images found.');

  const out = path.resolve(flags.out ?? path.join(
    path.dirname(files[0]),
    pdfFileName(path.basename(files[0]), options.title),
  ));
  const layout = options.pageSize === 'fit'
    ? 'pages fit each image'
    : `${PAGE_SIZES[options.pageSize].label}, ${options.orientation}`;
  console.log(`\n  ${files.length} image${files.length === 1 ? '' : 's'} -> ${path.basename(out)}  ` +
    `(${layout}, margin ${options.marginMm} mm, ` +
    `${options.compress ? `JPEG quality ${options.quality}` : 'original quality'})\n`);

  const images = await Promise.all(
    files.map(async (file) => ({ name: path.basename(file), data: await readFile(file) })),
  );
  const { data, info } = await imagesToPdf(images, options);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, data);

  printWarnings(info.warnings);
  console.log(
    `  ok    ${path.basename(out)}  ${info.pages} page${info.pages === 1 ? '' : 's'}  ` +
    `${formatBytes(info.sourceBytes)} -> ${formatBytes(info.bytes)}  ` +
    `(${formatSavings(info.sourceBytes, info.bytes)})  ${formatDuration(info.ms)}\n`,
  );
}

async function runPdfToImages(flags) {
  const { options, errors } = normalisePdfRenderOptions({
    format: flags.format,
    dpi: flags.dpi,
    pages: flags.pages,
    quality: flags.quality,
    targetBytes: flags['target-size'],
    maxWidth: flags['max-width'],
    maxHeight: flags['max-height'],
    background: flags.background,
    lossless: flags.lossless,
  });
  if (errors.length > 0) fail(errors[0].message);

  const files = await collect(flags._, {
    recursive: Boolean(flags.recursive),
    accept: (name) => extensionOfPath(name) === 'pdf',
  });
  if (files.length === 0) fail('No PDF files found.');

  const outDir = flags.out ? path.resolve(flags.out) : null;
  if (outDir) await mkdir(outDir, { recursive: true });

  console.log(`\n  ${files.length} PDF${files.length === 1 ? '' : 's'} -> ` +
    `${options.format.toUpperCase()} at ${options.dpi} DPI  (pages: ${options.pages || 'all'})\n`);

  // Pages from different PDFs share one output directory, so names are
  // claimed across the whole run rather than per document.
  const taken = new Set();
  const startedAt = performance.now();
  let written = 0;
  let totalBytes = 0;
  let failures = 0;

  for (const file of files) {
    try {
      const input = await readFile(file);
      const { pages, info } = await pdfToImages(input, options, { name: path.basename(file) });
      for (const page of pages) {
        const target = outDir
          ? path.join(outDir, uniqueName(page.name, taken))
          : path.join(path.dirname(file), page.name);
        await writeFile(target, page.data);
        written += 1;
        totalBytes += page.data.length;
        console.log(
          `  ok    ${path.basename(target).padEnd(34)} ` +
          `${`${page.info.width}x${page.info.height}`.padStart(11)}  ${formatBytes(page.data.length).padStart(9)}`,
        );
      }
      printWarnings(info.warnings);
    } catch (error) {
      failures += 1;
      console.error(`  fail  ${path.basename(file).padEnd(34)} ${error.message}`);
    }
  }

  console.log(
    `\n  ${written} page${written === 1 ? '' : 's'} from ${files.length - failures}/${files.length} ` +
    `PDF${files.length === 1 ? '' : 's'} in ${formatDuration(performance.now() - startedAt)}  ` +
    `-> ${formatBytes(totalBytes)}\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

const COMMANDS = {
  'images-to-pdf': runImagesToPdf,
  'pdf-to-images': runPdfToImages,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest, ARG_SPEC);
  const run = COMMANDS[command];

  if (!run || flags.help || flags._.length === 0) {
    console.log(USAGE);
    process.exit(command === '--help' || flags.help ? 0 : 1);
  }
  await run(flags);
}

main().catch((error) => {
  console.error(`  error  ${error.message}`);
  process.exit(1);
});
