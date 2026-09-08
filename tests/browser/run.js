/**
 * Browser end-to-end runner.
 *
 * Boots the real application server, adds two test-only routes to it, points
 * headless Chrome at the harness, and waits for the page to POST its results
 * back. Waiting on a real request rather than a DOM dump means the async
 * worker pipeline is allowed to finish on its own terms.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../server/index.js';
import { SECURITY_HEADERS } from '../../server/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const findChrome = () => CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('  No Chrome or Edge found. Set CHROME_PATH to run browser tests.');
    process.exit(1);
  }

  const harnessHtml = await readFile(path.join(HERE, 'harness.html'), 'utf8');
  const harnessJs = await readFile(path.join(HERE, 'harness.js'), 'utf8');

  // Reuse the production request handler so the harness runs against the real
  // routing, static serving and CSP - only the two test hooks are added.
  const app = createServer();
  const appHandler = app.listeners('request')[0];

  let resolveResults;
  const received = new Promise((resolve) => {
    resolveResults = resolve;
  });

  const server = http.createServer((req, res) => {
    if (req.url === '/__harness') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
      res.end(harnessHtml);
      return;
    }
    if (req.url === '/__harness.js') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/javascript; charset=utf-8',
      });
      res.end(harnessJs);
      return;
    }
    if (req.url === '/__results' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(204).end();
        resolveResults(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      });
      return;
    }
    appHandler(req, res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profile = await mkdtemp(path.join(tmpdir(), 'webp-forge-chrome-'));
  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    `${origin}/__harness`,
  ], { stdio: 'ignore' });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('browser tests timed out after 90s')), 90_000).unref());

  let payload;
  let exitCode = 0;
  try {
    payload = await Promise.race([received, timeout]);
  } finally {
    browser.kill();
    server.close();
    app.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n  Browser: ${path.basename(chrome)}`);
  if (payload.userAgent) {
    console.log(`  ${payload.userAgent}`);
    console.log(`  hardwareConcurrency: ${payload.hardwareConcurrency}\n`);
  }

  if (payload.fatal) {
    console.error(`  FATAL in harness:\n${payload.fatal}\n`);
    exitCode = 1;
  }

  let passed = 0;
  let failed = 0;
  for (const result of payload.results ?? []) {
    if (result.note) {
      console.log(`       ${result.note}`);
      continue;
    }
    if (result.ok) {
      passed += 1;
      console.log(`  ok   ${result.name}${result.ms ? `  (${result.ms}ms)` : ''}`);
    } else {
      failed += 1;
      console.log(`  FAIL ${result.name}\n         ${result.error}`);
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : exitCode);
}

main().catch((error) => {
  console.error(`  error  ${error.message}`);
  process.exit(1);
});
