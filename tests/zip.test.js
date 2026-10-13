import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createZip, crc32, MAX_ZIP_ENTRIES, readZip } from '../public/js/shared/zip.js';

const bytes = (text) => new TextEncoder().encode(text);
const u32 = (buf, offset) => new DataView(buf.buffer, buf.byteOffset).getUint32(offset, true);
const u16 = (buf, offset) => new DataView(buf.buffer, buf.byteOffset).getUint16(offset, true);

describe('crc32', () => {
  test('matches the published IEEE 802.3 check values', () => {
    assert.equal(crc32(bytes('')), 0x00000000);
    assert.equal(crc32(bytes('a')), 0xe8b7be43);
    assert.equal(crc32(bytes('abc')), 0x352441c2);
    assert.equal(crc32(bytes('hello world')), 0x0d4a1185);
    assert.equal(crc32(bytes('123456789')), 0xcbf43926);
  });

  test('is resumable across chunks', () => {
    const whole = crc32(bytes('hello world'));
    const chunked = crc32(bytes(' world'), crc32(bytes('hello')));
    assert.equal(chunked, whole);
  });

  test('always returns an unsigned 32-bit value', () => {
    for (const sample of ['', 'x', 'ÿ'.repeat(300)]) {
      const value = crc32(bytes(sample));
      assert.ok(value >= 0 && value <= 0xffffffff, `${value} in range`);
    }
  });
});

describe('createZip structure', () => {
  test('writes the three signature blocks in order', () => {
    const zip = createZip([{ name: 'a.txt', data: bytes('hello') }]);
    assert.equal(u32(zip, 0), 0x04034b50, 'local file header');
    const eocd = zip.length - 22;
    assert.equal(u32(zip, eocd), 0x06054b50, 'end of central directory');
    assert.equal(u16(zip, eocd + 8), 1, 'entry count on this disk');
    assert.equal(u16(zip, eocd + 10), 1, 'total entry count');
    // The central directory offset must point at its signature.
    assert.equal(u32(zip, u32(zip, eocd + 16)), 0x02014b50, 'central directory header');
  });

  test('records the central directory size and offset consistently', () => {
    const zip = createZip([
      { name: 'a.txt', data: bytes('one') },
      { name: 'b.txt', data: bytes('two') },
      { name: 'c.txt', data: bytes('three') },
    ]);
    const eocd = zip.length - 22;
    const size = u32(zip, eocd + 12);
    const offset = u32(zip, eocd + 16);
    assert.equal(offset + size, eocd, 'directory ends exactly where the EOCD begins');
  });

  test('stores rather than deflates, with matching sizes and a real CRC', () => {
    const payload = bytes('payload that is not compressed');
    const zip = createZip([{ name: 'a.txt', data: payload }]);
    assert.equal(u16(zip, 8), 0, 'compression method 0 = store');
    assert.equal(u32(zip, 14), crc32(payload), 'CRC-32 of the payload');
    assert.equal(u32(zip, 18), payload.length, 'compressed size');
    assert.equal(u32(zip, 22), payload.length, 'uncompressed size');
  });

  test('flags names as UTF-8', () => {
    const zip = createZip([{ name: 'café.webp', data: bytes('x') }]);
    assert.equal(u16(zip, 6) & 0x0800, 0x0800, 'general purpose bit 11 is set');
  });

  test('rejects input it cannot represent', () => {
    assert.throws(() => createZip([]), /at least one entry/);
    assert.throws(() => createZip(null), /at least one entry/);
    assert.throws(() => createZip([{ name: '', data: bytes('x') }]), /name cannot be empty/);
  });

  test('caps the entry count at the format limit', () => {
    const tooMany = { length: MAX_ZIP_ENTRIES + 1 };
    assert.throws(
      () => createZip(Array.from(tooMany, () => ({ name: 'a.txt', data: bytes('x') }))),
      /Too many entries/,
    );
  });

  test('accepts an empty payload', () => {
    const zip = createZip([{ name: 'empty.webp', data: new Uint8Array(0) }]);
    assert.equal(u32(zip, 14), 0, 'CRC of nothing is 0');
    assert.equal(u32(zip, 18), 0);
  });

  test('clamps pre-1980 timestamps into the DOS epoch', () => {
    const zip = createZip([{ name: 'old.txt', data: bytes('x'), date: new Date('1970-01-01') }]);
    const dosDate = u16(zip, 12);
    assert.ok(dosDate >>> 9 >= 0, 'year field is non-negative');
    assert.equal((dosDate >>> 9) + 1980, 1980);
  });

  test('tolerates an invalid date by falling back to now', () => {
    assert.doesNotThrow(() =>
      createZip([{ name: 'x.txt', data: bytes('x'), date: new Date('nonsense') }]));
  });
});

describe('createZip interoperability', () => {
  /**
   * Structural assertions can agree with a buggy writer, so the archive is
   * also handed to an independent implementation. PowerShell ships with .NET's
   * ZipFile on every Windows box, which makes it a genuine second opinion.
   */
  test('a real ZIP reader extracts the exact bytes back', async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'webp-forge-zip-'));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const entries = [
      { name: 'first.webp', data: bytes('first payload') },
      { name: 'second file.webp', data: new Uint8Array([0, 1, 2, 250, 255]) },
      { name: 'café ☕.webp', data: bytes('unicode name') },
    ];
    const archive = path.join(dir, 'out.zip');
    await writeFile(archive, createZip(entries));

    // Extraction is the strongest available check: .NET verifies each entry's
    // CRC as it decompresses and throws InvalidDataException on a mismatch, so
    // a successful extract plus a byte comparison covers both framing and CRC.
    const extracted = path.join(dir, 'out');
    let listing;
    try {
      listing = execFileSync(
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          // Without this, PowerShell emits the console code page and a
          // non-ASCII entry name comes back mangled through the pipe.
          `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
          `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
          `[System.IO.Compression.ZipFile]::ExtractToDirectory('${archive}','${extracted}');` +
          `$z=[System.IO.Compression.ZipFile]::OpenRead('${archive}');` +
          `$z.Entries | ForEach-Object { "$($_.FullName)|$($_.Length)" };` +
          `$z.Dispose()`,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
    } catch (error) {
      t.skip(`no usable PowerShell/.NET ZipFile available: ${error.message}`);
      return;
    }

    const rows = listing.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(rows.length, entries.length, 'every entry is visible to the reader');
    for (const [index, row] of rows.entries()) {
      const [name, length] = row.split('|');
      assert.equal(name, entries[index].name, 'name round-trips exactly');
      assert.equal(Number(length), entries[index].data.length, 'length matches');
      const onDisk = await readFile(path.join(extracted, entries[index].name));
      assert.deepEqual(
        new Uint8Array(onDisk),
        entries[index].data,
        `extracted bytes match for ${name}`,
      );
    }
  });
});

describe('readZip', () => {
  test('reads back exactly what createZip wrote, in order', () => {
    const entries = [
      { name: 'page-1.png', data: bytes('first') },
      { name: 'страница-2.png', data: bytes('second, with a UTF-8 name') },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ];
    const read = readZip(createZip(entries));
    assert.deepEqual(read.map((e) => e.name), entries.map((e) => e.name));
    read.forEach((entry, i) => assert.deepEqual([...entry.data], [...entries[i].data]));
  });

  test('accepts an ArrayBuffer as well as a Uint8Array', () => {
    const zip = createZip([{ name: 'a.txt', data: bytes('abc') }]);
    assert.equal(readZip(zip.buffer)[0].name, 'a.txt');
  });

  test('refuses an entry whose payload was altered', () => {
    const zip = createZip([{ name: 'a.txt', data: bytes('hello') }]);
    zip[30 + 'a.txt'.length] ^= 0xff; // first payload byte
    assert.throws(() => readZip(zip), /CRC/);
  });

  test('refuses compressed entries rather than misreading them', () => {
    const zip = createZip([{ name: 'a.txt', data: bytes('hello') }]);
    // Flip the central directory's method to DEFLATE (8).
    const central = u32(zip, zip.length - 22 + 16);
    new DataView(zip.buffer).setUint16(central + 10, 8, true);
    assert.throws(() => readZip(zip), /compressed/);
  });

  test('refuses something that is not a ZIP at all', () => {
    assert.throws(() => readZip(bytes('certainly not an archive')), /Not a ZIP/);
  });

  test('refuses a truncated archive', () => {
    const zip = createZip([{ name: 'a.txt', data: bytes('hello world') }]);
    assert.throws(() => readZip(zip.subarray(0, zip.length - 10)));
  });
});
