/**
 * Minimal ZIP writer, store-only (no DEFLATE).
 *
 * WebP payloads are already entropy-coded, so deflating them costs CPU and
 * saves nothing - storing is both the correct choice and the fast one. That
 * also keeps this dependency-free and lets one implementation serve the
 * browser's "download all" button and the CLI's archive mode.
 *
 * Archives stay within the classic 32-bit limits (no ZIP64): up to 65535
 * entries and 4 GiB total, which the batch caps sit comfortably under.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const UTF8_FLAG = 0x0800; // bit 11: names are UTF-8, not CP437
const STORE = 0;
const VERSION = 20; // 2.0 - the floor for a store-only archive

export const MAX_ZIP_ENTRIES = 65_535;
export const MAX_ZIP_BYTES = 0xffffffff;

let crcTable = null;

/** Build the standard CRC-32 (IEEE 802.3) lookup table once, on first use. */
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

/**
 * CRC-32 of `bytes`, optionally continuing a previous run.
 * @param {Uint8Array} bytes
 * @param {number} [seed] Result of an earlier call, to hash in chunks.
 */
export function crc32(bytes, seed = 0) {
  const table = getCrcTable();
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Pack a JS Date into the DOS time/date pair ZIP headers use. */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  // The DOS epoch starts in 1980; anything earlier clamps to it.
  const year = Math.max(1980, d.getFullYear());
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: dosDate & 0xffff };
}

/**
 * Build a ZIP archive in a single pre-sized allocation.
 *
 * @param {Array<{name: string, data: Uint8Array, date?: Date}>} entries
 * @returns {Uint8Array} The complete archive.
 */
export function createZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new RangeError('createZip needs at least one entry.');
  }
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new RangeError(`Too many entries for a ZIP archive (max ${MAX_ZIP_ENTRIES}).`);
  }

  const encoder = new TextEncoder();
  // Encode names and hash payloads up front so the exact output size is known
  // and the buffer is allocated exactly once.
  const prepared = entries.map((entry) => {
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const nameBytes = encoder.encode(entry.name);
    if (nameBytes.length === 0) throw new RangeError('ZIP entry name cannot be empty.');
    if (nameBytes.length > 0xffff) throw new RangeError(`ZIP entry name is too long: ${entry.name}`);
    return { data, nameBytes, crc: crc32(data), ...dosDateTime(entry.date) };
  });

  const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0);
  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const total = localSize + centralSize + 22;
  if (total > MAX_ZIP_BYTES) {
    throw new RangeError('Archive would exceed the 4 GiB ZIP limit - download in smaller batches.');
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  const u32 = (value) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };
  const u16 = (value) => {
    view.setUint16(offset, value, true);
    offset += 2;
  };
  const bytes = (chunk) => {
    out.set(chunk, offset);
    offset += chunk.length;
  };

  const localOffsets = [];
  for (const entry of prepared) {
    localOffsets.push(offset);
    u32(LOCAL_HEADER);
    u16(VERSION);
    u16(UTF8_FLAG);
    u16(STORE);
    u16(entry.time);
    u16(entry.date);
    u32(entry.crc);
    u32(entry.data.length); // compressed == uncompressed when stored
    u32(entry.data.length);
    u16(entry.nameBytes.length);
    u16(0); // no extra field
    bytes(entry.nameBytes);
    bytes(entry.data);
  }

  const centralStart = offset;
  prepared.forEach((entry, index) => {
    u32(CENTRAL_HEADER);
    u16(VERSION); // version made by
    u16(VERSION); // version needed
    u16(UTF8_FLAG);
    u16(STORE);
    u16(entry.time);
    u16(entry.date);
    u32(entry.crc);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(entry.nameBytes.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk number
    u16(0); // internal attributes
    u32(0o644 << 16); // external attributes: regular file, rw-r--r--
    u32(localOffsets[index]);
    bytes(entry.nameBytes);
  });

  // Snapshot the size before the EOCD record starts advancing `offset`.
  const centralSizeWritten = offset - centralStart;

  u32(END_OF_CENTRAL);
  u16(0); // this disk
  u16(0); // disk with the central directory
  u16(prepared.length);
  u16(prepared.length);
  u32(centralSizeWritten);
  u32(centralStart);
  u16(0); // archive comment length

  return out;
}

/**
 * Read a store-only archive - the kind `createZip` writes - back into entries.
 *
 * Walks the central directory, as unzip tools do, and checks every CRC.
 * Compressed entries are refused rather than misread: this exists to unpack
 * the archives this app produces, not arbitrary ZIP files.
 *
 * @param {Uint8Array|ArrayBuffer} input The complete archive.
 * @returns {Array<{name: string, data: Uint8Array}>} Entries in archive order;
 *   each `data` is a view into `input`, not a copy.
 */
export function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at) => view.getUint16(at, true);
  const u32 = (at) => view.getUint32(at, true);

  // The end record is 22 bytes plus a comment of up to 64 KiB, so scan back.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (u32(i) === END_OF_CENTRAL) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new RangeError('Not a ZIP archive.');

  const decoder = new TextDecoder();
  const entries = [];
  let offset = u32(end + 16);
  for (let n = u16(end + 10); n > 0; n -= 1) {
    if (offset + 46 > bytes.length || u32(offset) !== CENTRAL_HEADER) {
      throw new RangeError('The ZIP central directory is corrupt.');
    }
    const nameLength = u16(offset + 28);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (u16(offset + 10) !== STORE) {
      throw new RangeError(`ZIP entry "${name}" is compressed; only stored entries can be read.`);
    }

    const local = u32(offset + 42);
    if (local + 30 > bytes.length || u32(local) !== LOCAL_HEADER) {
      throw new RangeError(`ZIP entry "${name}" has a corrupt local header.`);
    }
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    const size = u32(offset + 20);
    if (start + size > bytes.length) throw new RangeError(`ZIP entry "${name}" is truncated.`);

    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== u32(offset + 16)) {
      throw new RangeError(`ZIP entry "${name}" failed its CRC check.`);
    }
    entries.push({ name, data });
    offset += 46 + nameLength + u16(offset + 30) + u16(offset + 32);
  }
  return entries;
}
