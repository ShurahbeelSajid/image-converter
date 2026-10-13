/**
 * Single source of truth for limits and format tables.
 * Imported unchanged by the browser, the HTTP server, and the CLI.
 */

/** Hard ceiling on an accepted upload. Mirrors the server's body limit. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Reject absurd canvases before decoding them (decompression-bomb guard). */
export const MAX_PIXELS = 100_000_000; // 100 MP
export const MAX_DIMENSION = 20_000;

/** WebP encoder bounds. */
export const QUALITY_MIN = 1;
export const QUALITY_MAX = 100;
export const QUALITY_DEFAULT = 82;

/** libwebp CPU/size trade-off. Higher = slower but smaller. Server-side only. */
export const EFFORT_MIN = 0;
export const EFFORT_MAX = 6;
export const EFFORT_DEFAULT = 4;

/** How many files one batch may hold, to keep the UI responsive. */
export const MAX_BATCH_FILES = 200;

/**
 * Formats we accept as input.
 *
 * The two engines have genuinely different reach, so both are recorded:
 * `canvasDecodable` is what an evergreen browser can decode locally, and
 * `serverDecodable` is what libvips can read. BMP is the awkward one - every
 * browser reads it, libvips does not - which is why the two flags exist rather
 * than one "supported" boolean.
 */
export const INPUT_FORMATS = Object.freeze({
  jpeg: { mime: 'image/jpeg', ext: ['jpg', 'jpeg', 'jpe', 'jfif'], canvasDecodable: true, serverDecodable: true },
  png: { mime: 'image/png', ext: ['png'], canvasDecodable: true, serverDecodable: true },
  gif: { mime: 'image/gif', ext: ['gif'], canvasDecodable: true, serverDecodable: true },
  webp: { mime: 'image/webp', ext: ['webp'], canvasDecodable: true, serverDecodable: true },
  bmp: { mime: 'image/bmp', ext: ['bmp', 'dib'], canvasDecodable: true, serverDecodable: false },
  avif: { mime: 'image/avif', ext: ['avif'], canvasDecodable: true, serverDecodable: true },
  tiff: { mime: 'image/tiff', ext: ['tif', 'tiff'], canvasDecodable: false, serverDecodable: true },
  heic: { mime: 'image/heic', ext: ['heic', 'heif'], canvasDecodable: false, serverDecodable: true },
});

/**
 * Colour composited under transparent pixels when the target format has no
 * alpha channel (JPEG). Without this, PNG transparency encodes as black.
 */
export const DEFAULT_BACKGROUND = '#ffffff';

/** PNG deflate level used when writing a lossless PNG. 9 = smallest. */
export const PNG_COMPRESSION_LEVEL = 9;

/** Bounds for an automatic target-size search. */
export const MIN_TARGET_BYTES = 1024; // 1 KB - below this nothing useful survives

/** Formats detectable by signature but explicitly not convertible here. */
export const REJECTED_FORMATS = Object.freeze({
  svg: 'SVG is a vector format — export it to PNG first.',
  ico: 'ICO icon containers are not supported.',
  pdf: 'PDF is a document, not an image - use "PDF to images" to render its pages.',
});

/** Most pages one PDF request may create or render. */
export const MAX_PDF_PAGES = 200;

/** Render resolution for PDF pages. 72 DPI is one pixel per PDF point. */
export const PDF_DPI_MIN = 36;
export const PDF_DPI_MAX = 600;
export const PDF_DPI_DEFAULT = 150;

/**
 * Pixel budget for one rendered PDF page. A4 at 600 DPI is ~35 MP; a poster
 * page that would blow past this is rendered at a lower DPI instead.
 */
export const MAX_PDF_RENDER_PIXELS = 40_000_000;

/** Combined upload limit for a batch of images bound into one PDF. */
export const MAX_BATCH_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB

/** File-extension allow list, derived from INPUT_FORMATS so it never drifts. */
export const ACCEPTED_EXTENSIONS = Object.freeze(
  Object.values(INPUT_FORMATS).flatMap((f) => f.ext),
);

/** `accept` attribute for <input type="file">. */
export const ACCEPT_ATTRIBUTE = [
  ...Object.values(INPUT_FORMATS).map((f) => f.mime),
  ...ACCEPTED_EXTENSIONS.map((e) => `.${e}`),
].join(',');
