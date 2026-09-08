# Image Forge

Convert and compress images **between any supported formats** — JPG, PNG, WebP,
AVIF, GIF, TIFF, in any direction — through a browser UI, an HTTP API, or a batch CLI.

Images are converted **locally in your browser** by a pool of Web Workers. Nothing
is uploaded, nothing leaves your machine, and the UI never blocks. A sharp/libvips
server engine picks up the formats a browser cannot decode or write.

```text
Convert   4 images · 3.12 MB → 374 KB · −88.3% · 117 ms
Compress  4 images · 3.12 MB → 418 KB · −86.9% · target 40 KB each
```

---

## Quick start

```bash
npm install
npm start          # → http://127.0.0.1:3000
```

Open the URL, drop images on the page, download the results individually or as a ZIP.

```bash
npm test               # 199 unit + integration tests
npm run test:browser   # 26 end-to-end tests in real headless Chrome
```

---

## Two modes

### Convert — change the format

Pick any target: **WebP, JPEG, PNG, AVIF, GIF, TIFF**. Every direction works —
JPG→PNG, PNG→JPG, JPG→WebP, WebP→JPG, PNG→AVIF, and so on.

### Compress — keep the format, shrink the file

Re-encodes each image as itself: JPEG stays JPEG, PNG stays PNG. Set a
**target size** ("200KB", "1.5MB", or a byte count) and the encoder searches for
the highest quality that fits, in at most 8 encodes.

| Control | What it does |
| --- | --- |
| Convert to | Target format, or `Same as source` for compression. |
| Quality | 1–100 (default 82). Inert for GIF, and for PNG in the browser. |
| Target size | Optional budget. Bisects quality to fit it. |
| Max width / height | Fit inside a box. Never upscales. |
| Background | Colour composited under transparency when the target has no alpha (PNG→JPG). |
| Engine | `Auto` (default), `Browser only`, or `Server (sharp)`. |
| Lossless | Pixel-exact where the format allows. Routes to the server — canvas has no lossless mode. |
| Keep metadata | Preserve EXIF/ICC. Stripped by default. |

---

## Format support

| Format | Read (browser) | Read (server) | Write | Notes |
| --- | :-: | :-: | :-: | --- |
| JPEG | ✅ | ✅ | ✅ | mozjpeg + progressive. No alpha — see Background. |
| PNG | ✅ | ✅ | ✅ | Server can palette-quantise (quality < 100); browser is always lossless. |
| WebP | ✅ | ✅ | ✅ | Lossy, lossless, and animation. |
| AVIF | ✅ | ✅ | server | Browsers decode AVIF but cannot encode it. |
| GIF | ✅ | ✅ | server | Palette-based; quality does not apply. |
| TIFF | ❌ | ✅ | server | JPEG-compressed unless lossless or alpha is needed. |
| BMP | ✅ | ❌ | ❌ | libvips has no BMP reader — see below. |
| HEIC | ❌ | ✅ | ❌ | Read-only. |

**The BMP case.** Browsers read BMP; libvips does not. Writing AVIF needs
libvips; browsers cannot. So BMP→AVIF fits neither engine alone — the app
decodes it locally to a lossless PNG and hands that to the server, so no quality
is lost and the combination still works.

---

## Three ways to use it

### 1. Browser UI

Drag and drop, or click to browse. Per-file before/after previews, the format
transition, size savings, and a "Download all (.zip)" button.

### 2. CLI

```bash
node cli/index.js photos/ -o dist/ -q 78 -r      # convert a tree to WebP
node cli/index.js shot.png -f jpeg               # PNG -> JPG
node cli/index.js photo.jpg -f png               # JPG -> PNG
node cli/index.js big/ -f same -t 200kb -o out/  # compress, keep formats
node cli/index.js hero.png --max-width 1600 --lossless
```

```text
  5 images -> source format  (quality 82, effort 4, target 40.0 KB, 8 parallel)

  ok    photo.jpg                             324 KB ->   38.6 KB   -88.1%  1200x800
  ok    logo.png                              706 KB ->   88.9 KB   -87.4%  600x400
  ...
  5/5 converted in 995 ms  1.46 MB -> 391 KB  (-73.9%)
```

`--help` lists every flag. Exits non-zero if any file failed.

### 3. HTTP API

The file is the raw request body — no multipart framing to parse on either end.

```bash
curl -X POST --data-binary @photo.png \
  -H 'x-filename: photo.png' \
  'http://127.0.0.1:3000/api/convert?format=jpeg&background=%23ffffff' \
  -o photo.jpg

curl -X POST --data-binary @big.jpg \
  'http://127.0.0.1:3000/api/convert?format=same&targetBytes=200kb' \
  -o small.jpg
```

| Route | |
| --- | --- |
| `GET /api/health` | `{ ok, engine, versions, maxUploadBytes, outputFormats }` |
| `POST /api/convert` | Raw image body → converted body. Options via query string. |

Query options: `format` (`webp`/`jpeg`/`png`/`avif`/`gif`/`tiff`/`same`, `jpg` aliases
`jpeg`), `quality`, `effort`, `targetBytes`, `maxWidth`, `maxHeight`, `background`,
`lossless`, `keepMetadata`.

`x-image-meta` carries the output and source formats, dimensions, byte counts,
the quality the search chose, and any warnings. Errors are JSON with a stable
`code`: `UNSUPPORTED_TYPE`, `TOO_LARGE`, `DIMENSIONS_TOO_LARGE`, `DECODE_FAILED`,
`INVALID_OPTION`, `SERVER_CANNOT_DECODE`, …

---

## How it's fast

- **Worker pool.** `hardwareConcurrency − 1` workers (capped at 8), each doing
  `createImageBitmap` → `OffscreenCanvas` → `convertToBlob`. Encoding never
  touches the main thread. Measured: 12 images in **43 ms wall vs 84 ms summed**.
- **Work stays local when it can.** Routing sends a job to sharp only when the
  browser genuinely cannot do it well — an unwritable format, lossless, or PNG
  quantisation. JPEG compression runs in-browser at **~80 ms** versus ~400 ms
  through the server.
- **Bounded search.** Target-size compression bisects quality in ≤ 8 encodes,
  and stops after one when the image already fits.
- **Cheap rejection.** Dimensions are parsed from container headers, so a
  60000×60000 pixel bomb is refused after ~24 bytes, before any decoder runs.
- **Store-only ZIP.** Already-compressed payloads; deflating them costs CPU and
  saves nothing.
- **Transferables.** Encoded bytes move to the main thread by transfer, not copy.
- **No framework, no build step.** Plain ES modules; the server is `node:http`.

---

## Correctness details worth knowing

- **PNG→JPG flattens transparency** onto the Background colour. JPEG has no
  alpha channel, and an unflattened conversion renders transparent pixels black.
  Both engines do this, and both say so — but only when the source could
  actually carry alpha.
- **EXIF orientation is applied before resizing**, so a phone photo is never
  sideways and the fit box applies to the upright image.
- **TIFF never uses LZW.** On photographic data LZW *inflates* files (measured:
  78 KB → 1.1 MB). Lossy TIFF is JPEG-compressed; lossless and alpha-bearing
  TIFFs use deflate.
- **Animation survives only where both ends support it.** GIF→WebP keeps frames;
  GIF→JPEG keeps the first and says so.
- **Lossless is honest.** Canvas has no lossless mode, so those requests go to
  sharp; browser-only mode encodes at maximum quality and tells you.

---

## Validation

Every input is judged by its **bytes**, never its extension or its
browser-reported MIME type.

| Check | Behaviour |
| --- | --- |
| Magic-byte sniffing | JPEG, PNG, GIF, WebP, BMP, TIFF, AVIF/HEIC |
| SVG / PDF / ICO | Refused with a specific reason, not a generic error |
| Extension mismatch | **Warns**, still converts — the bytes are authoritative |
| Empty / truncated file | Rejected before and during decode |
| Size limit | 50 MiB (`MAX_UPLOAD_BYTES` to change) |
| Pixel bomb | Max 20 000 px/side, 100 MP total, checked from the header |
| Batch size | 200 files |
| Filenames | Traversal, CRLF injection, control chars, Windows reserved names, over-long names |
| Options | Clamped when merely out of range; rejected when nonsensical |
| Path traversal | Static server refuses anything resolving outside `public/` |

---

## Tests

**199 Node tests** (`npm test`) — no test framework, just `node:test`. Fixtures
are generated by sharp at runtime, so the repo holds no opaque binaries.

- The **full conversion matrix**: 5 source formats × 6 output formats, each
  verified by magic bytes, not by the encoder's own say-so
- Alpha: preserved where supported, composited onto the background where not
- Target-size search: bisection, attempt bounds, memoisation, and honest
  reporting when a budget is unreachable — driven by a synthetic size curve, so
  the algorithm is tested without an encoder in the loop
- Format sniffing and header dimension parsing for every supported format
- Filename sanitising: traversal, injection, reserved names, Unicode truncation
- ZIP writer, verified against **.NET's `ZipFile`** by extracting and comparing bytes
- HTTP: real server on an ephemeral port, including six path-traversal attempts

**26 browser tests** (`npm run test:browser`) drive the real modules in real
headless Chrome — the worker pool, OffscreenCanvas encoding, PNG→JPG flattening
checked pixel by pixel, engine routing, object URLs, and the server engine over HTTP.

---

## Layout

```text
public/                 Frontend (served as-is, no build)
  index.html
  assets/styles.css
  js/
    app.js              UI controller, mode tabs
    converter.js        Worker pool, engine routing, BMP bridge
    worker.js           decode → resize → flatten → encode, off the main thread
    shared/             ← imported by BOTH browser and Node
      constants.js      limits, input-format capabilities
      output-formats.js output-format capabilities, format resolution
      compress.js       target-size search, size parsing
      signature.js      magic bytes + header dimensions
      validation.js     all validation rules
      filename.js       sanitising and extension swapping
      format.js         byte/percent/duration formatting
      zip.js            store-only ZIP writer + CRC-32
server/
  index.js              routes, listener
  convert.js            sharp pipeline, per-format encoders
  static.js             static files, containment check
  http.js               body reader, JSON helpers, security headers
cli/index.js            batch CLI
tests/                  199 node tests + browser E2E harness
```

`public/js/shared/` is deliberately the single source of truth: the server and
CLI import the very same validation, format and compression code the browser
runs, so the two paths cannot drift apart, and the test suite covers both at once.

---

## Configuration

| Variable | Default |
| --- | --- |
| `PORT` | `3000` |
| `HOST` | `127.0.0.1` |
| `MAX_UPLOAD_BYTES` | `52428800` (50 MiB) |

Limits used by the browser live in `public/js/shared/constants.js`.

## Requirements

Node ≥ 18.17. A current Chrome, Edge, Firefox or Safari 16.4+ for local encoding;
without it the app falls back to the server engine automatically.

## License

MIT
