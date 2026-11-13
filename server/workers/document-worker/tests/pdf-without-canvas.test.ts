import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { ATTACHMENT_LIMITS } from '../contract.ts';
import { parseAuthorizedBytes } from '../parse.ts';
import { pdfFixture, pdfObjectsFixture, unicodePdfFixture } from '../fixtures.ts';

// This file runs in its own Node test process, before PDF.js can populate its module cache.
// Reject even the installed optional dependency: success must not depend on a developer's canvas.
let canvasRequests = 0;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@napi-rs/canvas')) {
      canvasRequests++;
      throw Object.assign(new Error('Optional PDF rasterizer intentionally absent'), {
        code: 'MODULE_NOT_FOUND',
      });
    }
    return nextResolve(specifier, context);
  },
});

// Synthetic blank PDF generated with pypdf 6.4.0, PdfWriter.add_blank_page(72, 72),
// encrypt('synthetic-reader', 'synthetic-owner', algorithm='RC4-128'). No user data.
const encryptedPdf = Buffer.from(
  'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGNhOTI5ZmQ3OWI+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCA3MiA3MiBdCi9QYXJlbnQgMiAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1YgMgovUiAzCi9MZW5ndGggMTI4Ci9QIDQyOTQ5NjcyOTIKL0ZpbHRlciAvU3RhbmRhcmQKL08gPGNlOWNjZDNiNGVhZThhNTI5MzA0OGRjZmJiOWEyZDM3MjBlYTkxZDQ1NDI1MWRiOWRjOTQ2ZWNiMjk0YmU2MWE+Ci9VIDw4MjQ1ZTE4MmE1ODgyMTQ3ZGRkODk0MDg2NzYwNTk3ODI4YmY0ZTVlNGU3NThhNDE2NDAwNGU1NmZmZmEwMTA4Pgo+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNTkgMDAwMDAgbiAKMDAwMDAwMDExOCAwMDAwMCBuIAowMDAwMDAwMTY3IDAwMDAwIG4gCjAwMDAwMDAyNTkgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA2Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDw2NDY2NjM2MTY2MzUzNDMyMzczOTMwMzMzMjMwMzY2NDY0MzEzMTM0MzQzMTY0MzA2MjM1NjI2MTM5MzYzMTYyPiA8NjQ2NjYzNjE2NjM1MzQzMjM3MzkzMDMzMzIzMDM2NjQ2NDMxMzEzNDM0MzE2NDMwNjIzNTYyNjEzOTM2MzE2Mj4gXQovRW5jcnlwdCA1IDAgUgo+PgpzdGFydHhyZWYKNDc0CiUlRU9GCg==',
  'base64',
);

test(
  'PDF text extraction works without optional native canvas, including CJK and bounded failures',
  { timeout: 90_000 },
  async (t) => {
    t.after(() => hooks.deregister());
    assert.equal('DOMMatrix' in globalThis, false);
    const twoPages = await parseAuthorizedBytes('report.pdf', pdfFixture('Synthetic evidence', 2));
    assert.equal(twoPages.kind, 'text');
    if (twoPages.kind !== 'text') return;
    assert.equal(twoPages.pageCount, 2);
    assert.match(twoPages.text, /Synthetic evidence page 1/);
    assert.match(twoPages.text, /Synthetic evidence page 2/);

    const cjk = '你好世界。日本語テキスト한국어';
    const unicode = await parseAuthorizedBytes('unicode.pdf', unicodePdfFixture(cjk));
    assert.equal(unicode.kind, 'text');
    if (unicode.kind !== 'text') return;
    assert.ok(unicode.text.replace(/\s/g, '').includes(cjk));

    const limited = await parseAuthorizedBytes('long.pdf', pdfFixture('Bounded page', 101));
    assert.equal(limited.kind, 'text');
    if (limited.kind !== 'text') return;
    assert.equal(limited.pageCount, 101);
    assert.equal(limited.pagesRead, ATTACHMENT_LIMITS.pdfPages);
    assert.equal(limited.truncated, true);
    assert.ok(!limited.text.includes('page 101'));

    const longText = await parseAuthorizedBytes(
      'long-text.pdf',
      pdfFixture('word '.repeat(500), 100),
    );
    assert.equal(longText.kind, 'text');
    if (longText.kind !== 'text') return;
    assert.equal(longText.truncated, true);
    assert.ok(longText.text.length <= ATTACHMENT_LIMITS.textCharacters);

    const empty = await parseAuthorizedBytes(
      'no-text.pdf',
      pdfObjectsFixture([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nff0000>\nendstream',
        '<< /Length 27 >>\nstream\nq 72 0 0 72 0 0 cm /Im1 Do Q\nendstream',
      ]),
    );
    assert.equal(empty.kind, 'text');
    if (empty.kind !== 'text') return;
    assert.ok(empty.warnings.some((warning) => warning.includes('OCR')));
    await assert.rejects(parseAuthorizedBytes('encrypted.pdf', encryptedPdf), /PDF 已加密/);
    await assert.rejects(
      parseAuthorizedBytes('broken.pdf', Buffer.from('%PDF-1.4\nnot a document')),
      /PDF 正文解析失败/,
    );
    assert.ok(canvasRequests > 0, 'PDF.js actually attempted its optional canvas import');
    assert.equal(
      'DOMMatrix' in globalThis,
      false,
      'no substitute rendering polyfill was installed',
    );
  },
);
