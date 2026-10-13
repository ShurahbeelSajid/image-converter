/** Plumbing shared by the command-line tools. */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Minimal flag parser - enough for these tools, no dependency.
 *
 * Takes `--key value`, `--key=value` (the way to pass a value that starts with
 * a dash), short aliases, and boolean switches.
 *
 * @param {string[]} argv
 * @param {{aliases?: Record<string, string>, booleans?: string[]}} spec
 * @returns {Record<string, string|boolean> & {_: string[]}}
 */
export function parseArgs(argv, { aliases = {}, booleans = [] } = {}) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('-') || raw === '-') {
      flags._.push(raw);
      continue;
    }
    const eq = raw.indexOf('=');
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    const key = (aliases[name] ?? name).replace(/^--?/, '');
    if (booleans.includes(key)) {
      flags[key] = true;
      continue;
    }
    const value = eq > 0 ? raw.slice(eq + 1) : argv[i + 1];
    if (value === undefined || (eq < 0 && value.startsWith('-'))) {
      throw new Error(`Option --${key} needs a value.`);
    }
    flags[key] = value;
    if (eq < 0) i += 1;
  }
  return flags;
}

/** "page2" before "page10", case-insensitively. */
const naturalOrder = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Expand files and directories into a flat list of file paths.
 *
 * Files named explicitly keep the order they were given in. Directory entries
 * are sorted naturally, so a folder of scans comes out in reading order on
 * every platform rather than in whatever order the filesystem lists it.
 *
 * @param {string[]} inputs
 * @param {{recursive?: boolean, accept: (name: string) => boolean}} options
 *   `accept` filters directory entries; explicit files are always taken.
 */
export async function collect(inputs, { recursive = false, accept }) {
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
      const entries = (await readdir(dir, { withFileTypes: true }))
        .sort((a, b) => naturalOrder(a.name, b.name));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recursive) await walk(full);
        } else if (entry.isFile() && accept(entry.name)) {
          files.push(full);
        }
      }
    };
    await walk(input);
  }
  return files;
}

/** Lowercased extension of a path, without the dot. */
export const extensionOfPath = (file) => path.extname(file).slice(1).toLowerCase();
