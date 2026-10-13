import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  layoutPage, MAX_MARGIN_MM, MAX_PAGE_POINTS, mmToPoints, normalisePdfOptions,
  normalisePdfRenderOptions, orientationMatrix, pageImageName, parsePageRange, pdfFileName,
  sniffPdf,
} from '../public/js/shared/pdf.js';
import { PDF_DPI_DEFAULT, PDF_DPI_MAX, PDF_DPI_MIN } from '../public/js/shared/constants.js';

const text = (value) => new TextEncoder().encode(value);
const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 0.01, `${message}: ${actual} vs ${expected}`);

describe('sniffPdf', () => {
  test('recognises the header and reads the version', () => {
    assert.deepEqual(sniffPdf(text('%PDF-1.7\n%...')), { isPdf: true, version: '1.7' });
  });

  test('tolerates junk before the header, as readers do', () => {
    assert.equal(sniffPdf(text(`${'x'.repeat(500)}%PDF-1.4`)).isPdf, true);
  });

  test('gives up after the first kilobyte', () => {
    assert.equal(sniffPdf(text(`${'x'.repeat(1100)}%PDF-1.4`)).isPdf, false);
  });

  test('rejects images and empty input', () => {
    assert.equal(sniffPdf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).isPdf, false);
    assert.equal(sniffPdf(new Uint8Array(0)).isPdf, false);
  });
});

describe('parsePageRange', () => {
  test('blank and "all" select every page', () => {
    assert.deepEqual(parsePageRange('', 3).pages, [1, 2, 3]);
    assert.deepEqual(parsePageRange('  ALL ', 3).pages, [1, 2, 3]);
    assert.deepEqual(parsePageRange(undefined, 2).pages, [1, 2]);
  });

  test('takes single pages, ranges and open-ended ranges', () => {
    assert.deepEqual(parsePageRange('1-3, 5', 9).pages, [1, 2, 3, 5]);
    assert.deepEqual(parsePageRange('-2', 9).pages, [1, 2]);
    assert.deepEqual(parsePageRange('8-', 9).pages, [8, 9]);
    assert.deepEqual(parsePageRange('4 - 4', 9).pages, [4]);
  });

  test('sorts and de-duplicates overlapping selections', () => {
    assert.deepEqual(parsePageRange('5, 3, 1-3, 2', 9).pages, [1, 2, 3, 5]);
  });

  test('tolerates stray commas', () => {
    assert.deepEqual(parsePageRange('1,,3,', 3).pages, [1, 3]);
  });

  test('names a page that does not exist', () => {
    assert.match(parsePageRange('9', 3).error, /Page 9 does not exist - the PDF has 3 pages/);
    assert.match(parsePageRange('2-7', 3).error, /Page 7 does not exist/);
    assert.match(parsePageRange('8-', 3).error, /Page 8 does not exist/);
    assert.match(parsePageRange('2', 1).error, /has 1 page\./);
  });

  test('rejects nonsense with a reason', () => {
    assert.match(parsePageRange('5-3', 9).error, /runs backwards/);
    assert.match(parsePageRange('0', 9).error, /numbered from 1/);
    assert.match(parsePageRange('abc', 9).error, /not a page number/);
    assert.match(parsePageRange('-', 9).error, /not a page number/);
    assert.match(parsePageRange('1-2-3', 9).error, /not a page number/);
    assert.match(parsePageRange(',', 9).error, /at least one page/);
  });

  test('checks a huge range before expanding it', () => {
    const startedAt = performance.now();
    assert.ok(parsePageRange('1-999999999', 5).error);
    assert.ok(performance.now() - startedAt < 50, 'no loop over a billion pages');
  });
});

describe('layoutPage', () => {
  const options = (overrides = {}) => ({ pageSize: 'fit', orientation: 'auto', marginMm: 0, ...overrides });

  test('"fit" sizes the page from the resolution the image records', () => {
    // An A4 scan at 300 DPI comes back as an A4 page.
    const box = layoutPage(2480, 3508, options(), 300);
    close(box.pageWidth, 595.2, 'width');
    close(box.pageHeight, 841.92, 'height');
    assert.deepEqual([box.x, box.y], [0, 0]);
    assert.equal(box.width, box.pageWidth);
  });

  test('"fit" falls back to 96 DPI when the recorded one is absent or absurd', () => {
    for (const dpi of [null, 0, 1, 99999]) {
      close(layoutPage(960, 480, options(), dpi).pageWidth, 720, `dpi ${dpi}`);
    }
  });

  test('"fit" adds the margin around the image', () => {
    const box = layoutPage(960, 480, options({ marginMm: 10 }), 96);
    const margin = mmToPoints(10);
    close(box.pageWidth, 720 + 2 * margin, 'page grows by two margins');
    close(box.x, margin, 'image starts after the margin');
    close(box.width, 720, 'image keeps its size');
  });

  test('"fit" never exceeds the 200-inch page limit, keeping the aspect ratio', () => {
    const box = layoutPage(40000, 10000, options(), 72);
    assert.ok(box.pageWidth <= MAX_PAGE_POINTS + 0.01);
    close(box.width / box.height, 4, 'aspect ratio');
  });

  test('a paper size follows the image orientation by default', () => {
    const wide = layoutPage(1600, 900, options({ pageSize: 'a4' }));
    assert.ok(wide.pageWidth > wide.pageHeight, 'landscape for a wide image');
    const tall = layoutPage(900, 1600, options({ pageSize: 'letter' }));
    assert.deepEqual([tall.pageWidth, tall.pageHeight], [612, 792]);
  });

  test('an explicit orientation wins over the image shape', () => {
    const box = layoutPage(1600, 900, options({ pageSize: 'a4', orientation: 'portrait' }));
    assert.ok(box.pageHeight > box.pageWidth);
  });

  test('a paper size scales the image to fill the margin box, centred', () => {
    const box = layoutPage(100, 100, options({ pageSize: 'a4', marginMm: 20 }));
    const margin = mmToPoints(20);
    close(box.width, 595.28 - 2 * margin, 'a small image is scaled up to the box');
    close(box.width, box.height, 'square stays square');
    close(box.x, margin, 'touches the side margins');
    close(box.y + box.height / 2, 841.89 / 2, 'centred vertically');
  });
});

describe('orientationMatrix', () => {
  // Where the corners of the stored image land: PDF puts the stored image's
  // top-left (u=0, v=0) at unit-square point (0, 1).
  const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];
  const box = { x: 10, y: 20, width: 300, height: 200 };
  const corners = {
    topLeft: [box.x, box.y + box.height],
    topRight: [box.x + box.width, box.y + box.height],
    bottomLeft: [box.x, box.y],
    bottomRight: [box.x + box.width, box.y],
  };
  // EXIF: where the stored image's first pixel (top-left) is displayed.
  const storedTopLeftShownAt = {
    1: 'topLeft', 2: 'topRight', 3: 'bottomRight', 4: 'bottomLeft',
    5: 'topLeft', 6: 'topRight', 7: 'bottomRight', 8: 'bottomLeft',
  };

  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`orientation ${orientation} maps the image exactly onto the box`, () => {
      const matrix = orientationMatrix(orientation, box);
      const mapped = [[0, 0], [1, 0], [0, 1], [1, 1]].map((point) => apply(matrix, point));
      for (const corner of Object.values(corners)) {
        assert.ok(
          mapped.some(([x, y]) => Math.abs(x - corner[0]) < 1e-9 && Math.abs(y - corner[1]) < 1e-9),
          `covers corner ${corner}`,
        );
      }
      const shownAt = apply(matrix, [0, 1]);
      assert.deepEqual(shownAt, corners[storedTopLeftShownAt[orientation]], 'first pixel placement');
    });
  }

  test('anything unrecognised is drawn as stored', () => {
    assert.deepEqual(orientationMatrix(undefined, box), orientationMatrix(1, box));
    assert.deepEqual(orientationMatrix(42, box), orientationMatrix(1, box));
  });
});

describe('normalisePdfOptions', () => {
  test('defaults to fit-to-image pages with the originals untouched', () => {
    const { options, errors } = normalisePdfOptions();
    assert.deepEqual(errors, []);
    assert.deepEqual(options, {
      pageSize: 'fit', orientation: 'auto', marginMm: 0, compress: false,
      quality: 82, background: '#ffffff', title: null,
    });
  });

  test('accepts the query-string spellings', () => {
    const { options } = normalisePdfOptions({
      pageSize: 'A4', orientation: 'Landscape', margin: '12.5', compress: 'true', quality: '60',
    });
    assert.equal(options.pageSize, 'a4');
    assert.equal(options.orientation, 'landscape');
    assert.equal(options.marginMm, 12.5);
    assert.equal(options.compress, true);
    assert.equal(options.quality, 60);
  });

  test('clamps a large margin and rejects a negative one', () => {
    assert.equal(normalisePdfOptions({ margin: 500 }).options.marginMm, MAX_MARGIN_MM);
    assert.match(normalisePdfOptions({ margin: -1 }).errors[0].message, /margin/);
    assert.match(normalisePdfOptions({ margin: 'wide' }).errors[0].message, /margin/);
  });

  test('rejects unknown page sizes and orientations by name', () => {
    assert.match(normalisePdfOptions({ pageSize: 'b5' }).errors[0].message, /Unknown page size "b5"/);
    assert.match(normalisePdfOptions({ orientation: 'diagonal' }).errors[0].message, /orientation/);
  });

  test('shares the converter\'s quality and background rules', () => {
    assert.equal(normalisePdfOptions({ quality: 9999 }).options.quality, 100);
    assert.match(normalisePdfOptions({ background: 'red' }).errors[0].message, /hex colour/);
  });

  test('keeps a title to one printable, bounded line', () => {
    assert.equal(normalisePdfOptions({ title: '  Trip\r\nreport\u0000 ' }).options.title, 'Tripreport');
    assert.equal(normalisePdfOptions({ title: 'x'.repeat(500) }).options.title.length, 200);
    assert.equal(normalisePdfOptions({ title: '   ' }).options.title, null);
  });
});

describe('normalisePdfRenderOptions', () => {
  test('defaults to lossless PNG at 150 DPI, every page', () => {
    const { options, errors } = normalisePdfRenderOptions();
    assert.deepEqual(errors, []);
    assert.equal(options.format, 'png');
    assert.equal(options.quality, 100, 'PNG stays lossless without an explicit quality');
    assert.equal(options.dpi, PDF_DPI_DEFAULT);
    assert.equal(options.pages, '');
  });

  test('lossy formats get the usual default quality', () => {
    assert.equal(normalisePdfRenderOptions({ format: 'jpg' }).options.quality, 82);
  });

  test('an explicit PNG quality is honoured', () => {
    assert.equal(normalisePdfRenderOptions({ format: 'png', quality: '70' }).options.quality, 70);
  });

  test('clamps the resolution', () => {
    assert.equal(normalisePdfRenderOptions({ dpi: 5 }).options.dpi, PDF_DPI_MIN);
    assert.equal(normalisePdfRenderOptions({ dpi: 99999 }).options.dpi, PDF_DPI_MAX);
    assert.equal(normalisePdfRenderOptions({ dpi: 'high' }).options.dpi, PDF_DPI_DEFAULT);
  });

  test('"same" is meaningless for a PDF and says so', () => {
    assert.match(normalisePdfRenderOptions({ format: 'same' }).errors[0].message, /output format/);
  });

  test('carries the page selection through, trimmed', () => {
    assert.equal(normalisePdfRenderOptions({ pages: ' 1-3 ' }).options.pages, '1-3');
  });
});

describe('file names', () => {
  test('page images are zero-padded to the document length', () => {
    assert.equal(pageImageName('report.pdf', 7, 120, 'png'), 'report-page-007.png');
    assert.equal(pageImageName('report.pdf', 2, 9, 'jpeg'), 'report-page-2.jpg');
  });

  test('a hostile PDF name cannot escape into a path', () => {
    const name = pageImageName('../../secret/evil.pdf', 1, 1, 'png');
    assert.equal(name, 'evil-page-1.png');
  });

  test('a built PDF takes its title, else the first image name', () => {
    assert.equal(pdfFileName('IMG_0001.jpg'), 'IMG_0001.pdf');
    assert.equal(pdfFileName('IMG_0001.jpg', 'Trip v1.2'), 'Trip v1.2.pdf');
    assert.equal(pdfFileName('a.png', '../../etc/passwd'), 'passwd.pdf');
    assert.equal(pdfFileName(undefined), 'images.pdf');
  });
});
