import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  contentDisposition, replaceExtension, sanitizeFilename, toOutputName, uniqueName,
} from '../public/js/shared/filename.js';

describe('sanitizeFilename', () => {
  test('leaves an ordinary name alone', () => {
    assert.equal(sanitizeFilename('holiday-photo_01.jpg'), 'holiday-photo_01.jpg');
  });

  test('strips directory traversal down to a bare name', () => {
    assert.equal(sanitizeFilename('../../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('..\\..\\Windows\\System32\\cmd.exe'), 'cmd.exe');
    assert.equal(sanitizeFilename('/absolute/path/pic.png'), 'pic.png');
    assert.equal(sanitizeFilename('C:\\Users\\me\\pic.png'), 'pic.png');
  });

  test('removes characters that would break a header or a filesystem', () => {
    assert.equal(sanitizeFilename('a<b>c:d"e|f?g*h.png'), 'abcdefgh.png');
  });

  test('strips control characters, including CRLF header injection', () => {
    const attack = 'evil\r\nContent-Length: 0\r\n\r\n.png';
    const safe = sanitizeFilename(attack);
    assert.ok(!/[\r\n]/.test(safe), 'no newlines survive');
    // The colon goes too - it is in the Windows-reserved set.
    assert.equal(safe, 'evilContent-Length 0.png');
  });

  test('collapses whitespace runs', () => {
    assert.equal(sanitizeFilename('my    spaced   name.png'), 'my spaced name.png');
    assert.equal(sanitizeFilename('  padded.png  '), 'padded.png');
  });

  test('falls back when nothing usable remains', () => {
    for (const input of ['', '   ', '...', '..', '.', '///', null, undefined]) {
      assert.equal(sanitizeFilename(input), 'image');
    }
    assert.equal(sanitizeFilename('', { fallback: 'output' }), 'output');
  });

  test('rewrites Windows reserved device names', () => {
    assert.equal(sanitizeFilename('CON.png'), 'image.png');
    assert.equal(sanitizeFilename('nul.jpg'), 'image.jpg');
    assert.equal(sanitizeFilename('COM1.png'), 'image.png');
    assert.equal(sanitizeFilename('LPT9'), 'image');
  });

  test('leaves names that merely contain a reserved word', () => {
    assert.equal(sanitizeFilename('console.png'), 'console.png');
    assert.equal(sanitizeFilename('aux-panel.png'), 'aux-panel.png');
  });

  test('drops trailing dots and spaces that Windows would strip anyway', () => {
    assert.equal(sanitizeFilename('report.'), 'report');
    assert.equal(sanitizeFilename('report   '), 'report');
  });

  test('truncates a very long name without splitting a character', () => {
    const long = `${'é'.repeat(500)}.png`;
    const safe = sanitizeFilename(long);
    assert.ok(new TextEncoder().encode(safe).length <= 210, 'byte length is bounded');
    assert.ok(!safe.includes('\uFFFD'), 'no broken surrogate or replacement char');
    assert.ok(safe.endsWith('.png'), 'extension is preserved');
  });

  test('preserves non-ASCII names that are already fine', () => {
    assert.equal(sanitizeFilename('日本語の写真.png'), '日本語の写真.png');
    assert.equal(sanitizeFilename('café ☕.jpg'), 'café ☕.jpg');
  });
});

describe('toOutputName', () => {
  test('swaps the extension', () => {
    assert.equal(toOutputName('holiday.JPG', 'webp'), 'holiday.webp');
    assert.equal(toOutputName('shot.jpeg', 'webp'), 'shot.webp');
    assert.equal(toOutputName('logo.png', 'webp'), 'logo.webp');
  });

  test('only replaces the final extension', () => {
    assert.equal(toOutputName('archive.tar.gz', 'webp'), 'archive.tar.webp');
  });

  test('appends when there is no extension', () => {
    assert.equal(toOutputName('screenshot', 'webp'), 'screenshot.webp');
  });

  test('a dotfile keeps its name rather than becoming bare .webp', () => {
    assert.equal(toOutputName('.hidden', 'webp'), '.hidden.webp');
  });

  test('sanitises before renaming', () => {
    assert.equal(toOutputName('../../etc/passwd.png', 'webp'), 'passwd.webp');
    assert.equal(toOutputName('', 'webp'), 'image.webp');
  });
});

describe('uniqueName', () => {
  test('passes the first occurrence through untouched', () => {
    const taken = new Set();
    assert.equal(uniqueName('photo.webp', taken), 'photo.webp');
  });

  test('numbers subsequent collisions', () => {
    const taken = new Set();
    assert.equal(uniqueName('photo.webp', taken), 'photo.webp');
    assert.equal(uniqueName('photo.webp', taken), 'photo (2).webp');
    assert.equal(uniqueName('photo.webp', taken), 'photo (3).webp');
  });

  test('collides case-insensitively, matching Windows and macOS', () => {
    const taken = new Set();
    uniqueName('Photo.webp', taken);
    assert.equal(uniqueName('photo.webp', taken), 'photo (2).webp');
  });

  test('skips a suffix that is itself already taken', () => {
    const taken = new Set();
    uniqueName('photo.webp', taken);
    uniqueName('photo (2).webp', taken);
    assert.equal(uniqueName('photo.webp', taken), 'photo (3).webp');
  });

  test('handles names without an extension', () => {
    const taken = new Set();
    uniqueName('photo', taken);
    assert.equal(uniqueName('photo', taken), 'photo (2)');
  });
});

describe('contentDisposition', () => {
  test('emits both an ASCII fallback and a UTF-8 name', () => {
    const header = contentDisposition('café.webp');
    assert.match(header, /^attachment; filename="caf_\.webp"; filename\*=UTF-8''/);
    assert.match(header, /filename\*=UTF-8''caf%C3%A9\.webp$/);
  });

  test('honours the disposition type', () => {
    assert.match(contentDisposition('a.webp', 'inline'), /^inline; /);
  });

  test('a hostile name cannot break out of the header', () => {
    const header = contentDisposition('a"; attachment; filename="b.exe');
    assert.ok(!/[\r\n]/.test(header), 'no newlines');
    // The quoted segment must contain no bare quote that would end it early.
    const quoted = header.match(/filename="([^"]*)"/)[1];
    assert.ok(!quoted.includes('"'), 'inner quotes are neutralised');
  });

  test('a traversal attempt is flattened', () => {
    assert.match(contentDisposition('../../etc/passwd'), /filename="passwd"/);
  });
});
