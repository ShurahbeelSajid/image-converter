# Image Forge

Convert and compress images **between any supported formats** — JPG, PNG, WebP,
AVIF, GIF, TIFF, in any direction — **bind images into a PDF**, or **render a PDF's
pages as images**, through a browser UI, an HTTP API, or batch CLIs.

Images are converted **locally in your browser** by a pool of Web Workers. Nothing
is uploaded, nothing leaves your machine, and the UI never blocks. A sharp/libvips
server engine, running on the same machine, picks up the formats a browser cannot
decode or write — and the PDF work, via pdf-lib and Mozilla's pdf.js.

```text
Convert        4 images · 3.12 MB → 374 KB · −88.3% · 117 ms
Compress       4 images · 3.12 MB → 418 KB · −86.9% · target 40 KB each
Images → PDF   4 images → 1 PDF · 4 pages · A4 · JPEGs embedded untouched
PDF → Images   report.pdf → 12 PNGs at 150 DPI
```

---

## Quick start

**Windows:** double-click **`start.bat`**. That is all — on any Windows 10/11 PC
it checks everything the app needs, fetches what is missing, starts the server and
opens your browser. See [The launcher](#the-launcher-startbat) for what it checks.

**Anywhere else** (or by hand):

```bash
npm install
npm start          # → http://127.0.0.1:3000
```

Open the URL, drop images on the page, download the results individually or as a ZIP.

```bash
npm test               # 296 unit + integration tests
npm run test:browser   # 30 end-to-end tests in real headless Chrome
npm run doctor         # prove every engine works on this machine
```

---

## The launcher (`start.bat`)

Copy the project folder to any Windows PC and double-click `start.bat`. Each step
prints `[ok]`, or explains what it is fixing:

| Check | When it is missing or broken |
| --- | --- |
| Windows 10/11, 64-bit (x64 or ARM64) | Stops with an explanation — Node.js no longer runs on older or 32-bit Windows. |
| Node.js ≥ 22.13 | Downloads the current Node.js LTS **into `.runtime\`** — a private copy, no installer, no admin rights, nothing changed system-wide. The download is verified against the SHA-256 nodejs.org publishes, and an interrupted download is reused once it verifies. An existing, new-enough Node.js is used as is. |
| npm | Ships with Node.js; checked anyway. |
| npm packages (sharp, pdf-lib, pdfjs-dist, @napi-rs/canvas) | Installed from `package-lock.json` with `npm ci`; reinstalled when missing, broken, or out of date after a `git pull`. |
| Every engine actually works | `scripts/doctor.js` encodes an image and round-trips a PDF. Native modules copied from another machine look installed but do not load — only running them shows it. |
| A free port | Uses 3000, else the next free one. If Image Forge is already running, the browser is pointed at it rather than a second server started. |

Then the server starts and the browser opens. Leave the window open while you use
the app; close it (or press Ctrl+C) to stop.

`start.bat --check` runs every check and install step without starting the app.
The internet is needed only the first time on a PC. Behind a TLS-inspecting
corporate proxy, npm is told to trust the Windows certificate store, as PowerShell
already does. If anything still fails, `npm run doctor` names the broken piece.

---

## Four modes

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

### Images → PDF — one page per image

Drop images; they queue up as pages in the order you add them, and the arrows
reorder them. **Create PDF** builds the document.

| Control | What it does |
| --- | --- |
| Page size | `Fit to image` (default), A4, US Letter, US Legal, A3, A5. |
| Orientation | `Match image` (landscape page for a wide image), or force portrait / landscape. |
| Margin | Space around each image, 0–50 mm. |
| Images | `Original quality`, or `Compress (JPEG)` with a quality slider for a smaller file. |
| Background | With compression: the colour under transparency, which JPEG cannot keep. |

**Fit to image** makes each page the image's own size at the resolution it records,
so a 300 DPI A4 scan comes back as exactly an A4 page (96 DPI is assumed when an
image records none). Paper sizes scale each image to fill the area inside the
margins and centre it.

### PDF → Images — one image per page

Drop PDFs; every page is rendered and saved as **PNG** (default), JPEG, WebP, AVIF,
TIFF or GIF. Choose the **resolution** (72–600 DPI, default 150), a **page
selection** such as `1-3, 5` or `8-`, the quality for lossy formats, and the page
background. Pages are named `report-page-07.png` — zero-padded, so they sort in order.

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
| PDF | — | ✅ | ✅ | Its own two modes: rendered by pdf.js, written by pdf-lib. |

**The BMP case.** Browsers read BMP; libvips does not. Writing AVIF needs
libvips; browsers cannot. So BMP→AVIF fits neither engine alone — the app
decodes it locally to a lossless PNG and hands that to the server, so no quality
is lost and the combination still works. Images → PDF uses the same bridge.

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

PDFs have their own CLI, over the same engine as the API:

```bash
node cli/pdf.js images-to-pdf scans/ -o scans.pdf -s a4       # a folder, in name order
node cli/pdf.js images-to-pdf cover.jpg p1.png -o book.pdf --compress -q 75
node cli/pdf.js pdf-to-images report.pdf -o pages/ -f jpeg --dpi 200
node cli/pdf.js pdf-to-images report.pdf --pages 1-3 -f webp
```

A directory's images are taken in natural order — `page2` before `page10` — and
files named on the command line keep the order given. `--pages=-3` (with `=`)
passes a value that starts with a dash.

### 3. HTTP API

A single file is the raw request body — no multipart framing to parse on either
end. Only binding several images into one PDF uses multipart, since several files
need framing; Node's built-in parser handles it, with no added dependency.

```bash
curl -X POST --data-binary @photo.png \
  -H 'x-filename: photo.png' \
  'http://127.0.0.1:3000/api/convert?format=jpeg&background=%23ffffff' \
  -o photo.jpg

curl -X POST --data-binary @big.jpg \
  'http://127.0.0.1:3000/api/convert?format=same&targetBytes=200kb' \
  -o small.jpg
```

```bash
# Images -> PDF: several images as multipart/form-data, in page order
curl -F file=@cover.jpg -F file=@page2.png \
  'http://127.0.0.1:3000/api/images-to-pdf?pageSize=a4&margin=10' -o book.pdf

# PDF -> images: the PDF as the raw body; the pages come back as a ZIP
curl -X POST --data-binary @report.pdf -H 'x-filename: report.pdf' \
  'http://127.0.0.1:3000/api/pdf-to-images?format=jpeg&dpi=200&pages=1-3' -o pages.zip
```

| Route | |
| --- | --- |
| `GET /api/health` | `{ ok, engine, versions, maxUploadBytes, maxBatchUploadBytes, outputFormats, pdf: { create, render } }` |
| `POST /api/convert` | Raw image body → converted body. Options via query string. |
| `POST /api/images-to-pdf` | Multipart images (any field name, in order) — or one raw image — → `application/pdf`. |
| `POST /api/pdf-to-images` | Raw PDF body → `application/zip` of the rendered pages. |

Query options for `/api/convert`: `format` (`webp`/`jpeg`/`png`/`avif`/`gif`/`tiff`/`same`,
`jpg` aliases `jpeg`), `quality`, `effort`, `targetBytes`, `maxWidth`, `maxHeight`,
`background`, `lossless`, `keepMetadata`.

`/api/images-to-pdf` takes `pageSize` (`fit`/`a4`/`letter`/`legal`/`a3`/`a5`),
`orientation` (`auto`/`portrait`/`landscape`), `margin` (mm), `compress`, `quality`,
`background` and `title`. `/api/pdf-to-images` takes every `/api/convert` option
except `same`, plus `dpi` (36–600) and `pages` (`1-3,5`, `8-`, `all`); `format`
defaults to PNG, which stays lossless unless a `quality` is given.

`x-image-meta` carries the output and source formats, dimensions, byte counts,
the quality the search chose, and any warnings; the PDF routes answer with
`x-pdf-meta` in the same spirit, including per-page sizes. Errors are JSON with
a stable `code`: `UNSUPPORTED_TYPE`, `TOO_LARGE`, `DIMENSIONS_TOO_LARGE`,
`DECODE_FAILED`, `INVALID_OPTION`, `SERVER_CANNOT_DECODE`, `TOO_MANY_PAGES`,
`PDF_ENCRYPTED`, …

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

### PDFs

- **JPEGs go into a PDF byte for byte.** PDF stores JPEG natively, so re-encoding
  would only lose quality. Even an EXIF-rotated phone photo is embedded untouched:
  its orientation becomes a PDF transformation matrix, verified for all eight EXIF
  orientations by rendering the PDF back and checking where each corner lands.
- **Everything else goes in losslessly.** Decoded by sharp and deflated with
  Node's native zlib — several times faster than pdf-lib's JavaScript PNG path —
  with transparency kept as a soft mask. `Compress` trades that for JPEG.
- **A multi-page TIFF is a document,** so every page becomes a PDF page. An
  animated GIF's frames are not pages: it contributes frame one, and says so.
- **Rendered pages reuse the image pipeline.** pdf.js paints each page; its raw
  pixels go straight into the same encoder as a conversion, so every output
  format, target-size search and resize behaves identically, with no
  intermediate file in between.
- **PNG pages stay lossless by default.** At the usual default quality sharp
  would palette-quantise them; document pages keep crisp text instead, unless a
  quality is asked for.
- **Bounded work.** At most 200 pages per request either way. A giant page — a
  200-inch poster at 600 DPI — is rendered at a lower DPI that fits a 40 MP
  budget, with a warning, instead of exhausting memory.
- **Hardened rendering.** pdf.js parses fonts without `eval` (closing off the bug
  class behind CVE-2024-4367 regardless of version), never runs XFA forms, and
  skips images inside a PDF that would decode to more than 100 MP.
- **Password-protected PDFs** are refused with `PDF_ENCRYPTED` and a plain reason.

---

## Validation

Every input is judged by its **bytes**, never its extension or its
browser-reported MIME type.

| Check | Behaviour |
| --- | --- |
| Magic-byte sniffing | JPEG, PNG, GIF, WebP, BMP, TIFF, AVIF/HEIC — and PDF, for the PDF modes |
| SVG / ICO | Refused with a specific reason, not a generic error |
| A PDF where an image belongs (or the reverse) | Refused with a pointer to the mode that handles it |
| PDF batch | 200 images into one PDF, up to 200 MiB combined; 200 pages rendered per PDF |
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

**296 Node tests** (`npm test`) — no test framework, just `node:test`. Fixtures
are generated by sharp and pdf-lib at runtime, so the repo holds no opaque binaries.

- The **full conversion matrix**: 5 source formats × 6 output formats, each
  verified by magic bytes, not by the encoder's own say-so
- Alpha: preserved where supported, composited onto the background where not
- Target-size search: bisection, attempt bounds, memoisation, and honest
  reporting when a budget is unreachable — driven by a synthetic size curve, so
  the algorithm is tested without an encoder in the loop
- Format sniffing and header dimension parsing for every supported format
- Filename sanitising: traversal, injection, reserved names, Unicode truncation
- ZIP writer, verified against **.NET's `ZipFile`** by extracting and comparing
  bytes; ZIP reader, including tampered, compressed and truncated archives
- HTTP: real server on an ephemeral port, including six path-traversal attempts
- PDFs, checked by rendering the output back rather than trusting the writer:
  all eight EXIF orientations, JPEG passthrough found byte for byte inside the
  PDF, transparency showing the page through, a lossless pixel round trip,
  multi-page TIFF, page sizes and margins, page ranges, every render format,
  the memory budget on a giant page, and encrypted, corrupt and non-PDF input

**30 browser tests** (`npm run test:browser`) drive the real modules in real
headless Chrome — the worker pool, OffscreenCanvas encoding, PNG→JPG flattening
checked pixel by pixel, engine routing, object URLs, the server engine over HTTP,
and both PDF tools, including the BMP bridge and unpacking pages in the browser.

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
    pdf-ui.js           the two PDF modes: page queue, results
    pdf-client.js       fetch wrappers for the PDF routes
    shared/             ← imported by BOTH browser and Node
      constants.js      limits, input-format capabilities
      output-formats.js output-format capabilities, format resolution
      compress.js       target-size search, size parsing
      signature.js      magic bytes + header dimensions
      validation.js     all validation rules
      filename.js       sanitising and extension swapping
      format.js         byte/percent/duration formatting
      pdf.js            PDF options, page ranges, page layout, EXIF matrices
      zip.js            store-only ZIP writer and reader + CRC-32
server/
  index.js              routes, listener
  convert.js            sharp pipeline, per-format encoders
  pdf.js                images → PDF (pdf-lib), PDF → images (pdf.js)
  static.js             static files, containment check
  http.js               body reader, JSON helpers, security headers
cli/
  index.js              batch image CLI
  pdf.js                images-to-pdf / pdf-to-images CLI
  common.js             argument parsing, directory walking
scripts/
  doctor.js             proves every dependency works (npm run doctor)
  launch.js             free port, start server, open browser
start.bat               one-click Windows launcher - checks and installs everything
tests/                  296 node tests + browser E2E harness
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
| `MAX_UPLOAD_BYTES` | `52428800` (50 MiB) — one image, or one PDF |
| `MAX_BATCH_UPLOAD_BYTES` | `209715200` (200 MiB) — all the images bound into one PDF |

Limits used by the browser live in `public/js/shared/constants.js`.

## Requirements

Node ≥ 22.13 (pdf.js needs it) — on Windows, `start.bat` provides it when the PC
has none. A current Chrome, Edge, Firefox or Safari 16.4+ for local encoding;
without it the app falls back to the server engine automatically.

PDF rendering uses `@napi-rs/canvas`, which ships prebuilt binaries for Windows,
macOS and Linux on x64 and ARM64 — no compiler needed. Where it cannot load,
everything else keeps working and the PDF → Images tab says why.

## License

MIT
