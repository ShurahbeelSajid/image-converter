#!/usr/bin/env node
/**
 * One-step launcher: start the server on a free port and open the browser.
 *
 * start.bat ends here. A busy port is not an error: if Image Forge itself is
 * answering there (start.bat double-clicked twice) the browser is pointed at
 * that instance, and otherwise the next port is tried.
 *
 * Flags: --no-open  start the server without opening a browser.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

import { startServer } from '../server/index.js';

const HOST = process.env.HOST || '127.0.0.1';
const PREFERRED_PORT = Number(process.env.PORT) || 3000;
const PORTS_TO_TRY = 20;
const shouldOpen = !process.argv.includes('--no-open');

/** Is an Image Forge server already answering on `port`? */
async function imageForgeOn(port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = await response.json();
    return body?.ok === true && body?.engine === 'sharp';
  } catch {
    return false;
  }
}

/** Open `url` in the default browser. Best effort: the URL is printed anyway. */
function openBrowser(url) {
  const [command, args, extra] = process.platform === 'win32'
    // `start` is a cmd built-in. Its first quoted argument is a window title,
    // hence the empty "" before the URL.
    ? ['cmd.exe', ['/d', '/s', '/c', `"start "" "${url}""`], { windowsVerbatimArguments: true }]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {}];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', ...extra });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser to open - the printed URL still works */
  }
}

async function main() {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + PORTS_TO_TRY; port += 1) {
    try {
      const server = await startServer({ port, host: HOST });
      const url = `http://${HOST}:${server.address().port}`;
      if (port !== PREFERRED_PORT) console.log(`  (port ${PREFERRED_PORT} was taken, so ${port} is used)`);
      console.log('\n  Leave this window open while you use Image Forge.');
      console.log('  Close it, or press Ctrl+C, to stop the server.\n');
      if (shouldOpen) openBrowser(url);
      return;
    } catch (error) {
      // EACCES covers ports Windows reserves (Hyper-V, WSL) as well as true
      // permission problems; either way, move along.
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
      if (await imageForgeOn(port)) {
        const url = `http://${HOST}:${port}`;
        console.log(`  Image Forge is already running -> ${url}`);
        if (shouldOpen) openBrowser(url);
        return;
      }
    }
  }
  throw new Error(
    `No free port between ${PREFERRED_PORT} and ${PREFERRED_PORT + PORTS_TO_TRY - 1}. ` +
    'Set PORT to choose another.',
  );
}

main().catch((error) => {
  console.error(`  error  ${error.message}`);
  process.exit(1);
});
