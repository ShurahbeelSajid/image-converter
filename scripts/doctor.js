#!/usr/bin/env node
/**
 * Environment check: can this machine run Image Forge?
 *
 * Each dependency is proven by use rather than by presence - a native module
 * copied over from another machine is "installed" but will not load, and only
 * running it shows that. Also checks the installed versions against
 * package-lock.json, so a `git pull` that changed a dependency is noticed.
 *
 * Exits 0 when everything works, 1 otherwise. `--quiet` prints only failures;
 * start.bat uses that to decide whether to reinstall.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const quiet = process.argv.includes('--quiet');

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

await check('Node.js', () => {
  // engines is ">=MAJOR.MINOR"; anything fancier would need a semver parser.
  const [, major, minor] = /(\d+)\.(\d+)/.exec(pkg.engines.node) ?? [];
  const [haveMajor, haveMinor] = process.versions.node.split('.').map(Number);
  const ok = haveMajor > Number(major) || (haveMajor === Number(major) && haveMinor >= Number(minor));
  if (!ok) throw new Error(`${process.versions.node} is too old - ${pkg.engines.node} is required.`);
  return `${process.versions.node} (${process.platform}-${process.arch})`;
});

await check('Installed versions', async () => {
  const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const stale = [];
  for (const name of Object.keys(pkg.dependencies)) {
    const wanted = lock.packages?.[`node_modules/${name}`]?.version;
    let installed = null;
    try {
      installed = require(`${name}/package.json`).version;
    } catch {
      /* reported below as missing */
    }
    if (!installed) stale.push(`${name} is missing`);
    else if (wanted && installed !== wanted) stale.push(`${name} is ${installed}, lockfile wants ${wanted}`);
  }
  if (stale.length) throw new Error(stale.join('; '));
  return 'match package-lock.json';
});

await check('sharp (image engine)', async () => {
  const { default: sharp } = await import('sharp');
  // An encode exercises the native libvips binary, not just the JS wrapper.
  await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).webp().toBuffer();
  return `sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`;
});

await check('@napi-rs/canvas (PDF rendering)', () => {
  const canvas = require('@napi-rs/canvas');
  canvas.createCanvas(2, 2).getContext('2d').fillRect(0, 0, 1, 1);
  return require('@napi-rs/canvas/package.json').version;
});

await check('PDF round trip', async () => {
  const { imagesToPdf, pdfEngineVersions, pdfToImages } = await import('../server/pdf.js');
  const { normalisePdfOptions, normalisePdfRenderOptions } = await import('../public/js/shared/pdf.js');
  const { default: sharp } = await import('sharp');
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#38bdf8' } })
    .png()
    .toBuffer();
  const { data } = await imagesToPdf([{ name: 'probe.png', data: png }], normalisePdfOptions().options);
  const { pages } = await pdfToImages(data, normalisePdfRenderOptions({ dpi: 72 }).options);
  if (pages.length !== 1) throw new Error('the probe PDF did not render back.');
  const versions = await pdfEngineVersions();
  return `pdf-lib ${versions.pdfLib}, pdf.js ${versions.pdfjs}`;
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  if (quiet && result.ok) continue;
  console.log(`  ${result.ok ? 'ok  ' : 'FAIL'}  ${result.name.padEnd(32)} ${result.detail}`);
}
if (!quiet) {
  console.log(failed.length
    ? `\n  ${failed.length} problem${failed.length === 1 ? '' : 's'} - reinstall with \`npm ci\`.\n`
    : '\n  Everything Image Forge needs is working.\n');
}
process.exit(failed.length ? 1 : 0);
