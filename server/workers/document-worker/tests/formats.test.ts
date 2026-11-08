import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ATTACHMENT_LIMITS } from '../contract.ts';
import { parseAuthorizedBytes } from '../parse.ts';
import { pdfFixture, docxFixture } from '../fixtures.ts';

// The production codec receives bytes only; Rust owns file access and process cancellation.
async function fixture() {
  return {
    put: (name: string, bytes: Buffer | string) => parseAuthorizedBytes(name, Buffer.from(bytes)),
    async close() {},
  };
}

test(
  'PDF parser extracts actual multi-page text and reports page limit',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture();
    try {
      const result = await f.put('report.pdf', pdfFixture('OpenBot PDF evidence', 2));
      t.diagnostic('Parsed the two-page PDF');
      assert.equal(result.kind, 'text');
      if (result.kind !== 'text') return;
      assert.match(result.text, /OpenBot PDF evidence page 1/);
      assert.match(result.text, /OpenBot PDF evidence page 2/);
      assert.equal(result.pageCount, 2);
      assert.equal(result.truncated, false);
      const limited = await f.put('long.pdf', pdfFixture('Bounded page', 101));
      t.diagnostic('Parsed the 100-page limit fixture');
      assert.equal(limited.kind, 'text');
      if (limited.kind !== 'text') return;
      assert.equal(limited.pageCount, 101);
      assert.equal(limited.pagesRead, 100);
      assert.equal(limited.truncated, true);
      assert.ok(!limited.text.includes('page 101'));
      await assert.rejects(f.put('broken.pdf', '%PDF-1.4\nnot a document'), /PDF/);
    } finally {
      await f.close();
    }
  },
);

test(
  'DOCX extracts Chinese paragraphs and rejects entity definitions and zip bombs',
  { timeout: 90_000 },
  async () => {
    const f = await fixture();
    try {
      const result = await f.put('brief.docx', docxFixture('OpenBot 文档实际正文与项目计划。'));
      assert.equal(result.kind, 'text');
      if (result.kind !== 'text') return;
      assert.match(result.text, /文档实际正文与项目计划/);
      assert.equal(result.truncated, false);
      await assert.rejects(
        f.put(
          'entities.docx',
          docxFixture('safe', {
            'word/extra.xml': '<!DOCTYPE a [<!ENTITY x "secret">]><a>&x;</a>',
          }),
        ),
        /DTD|实体/,
      );
      await assert.rejects(
        f.put(
          'bomb.docx',
          docxFixture(
            'safe',
            { 'word/big.xml': Buffer.alloc(ATTACHMENT_LIMITS.zipEntryBytes + 1, 65) },
            true,
          ),
        ),
        /解压|限制/,
      );
      await assert.rejects(
        f.put('traversal.docx', docxFixture('safe', { '../outside.xml': 'bad' })),
        /压缩包|路径/,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'PNG JPEG and WebP are decoded, metadata stripped and normalized for model input',
  { timeout: 90_000 },
  async () => {
    const f = await fixture();
    try {
      for (const format of ['png', 'jpeg', 'webp'] as const) {
        const bytes = await sharp({
          create: { width: 320, height: 180, channels: 3, background: '#4589ff' },
        })
          .toFormat(format)
          .toBuffer();
        const result = await f.put(`picture.${format}`, bytes);
        assert.equal(result.kind, 'image');
        if (result.kind !== 'image') continue;
        assert.equal(result.mimeType, 'image/png');
        assert.equal(result.sourceMimeType, `image/${format}`);
        assert.equal(result.width, 320);
        assert.equal(result.height, 180);
        const decoded = await sharp(Buffer.from(result.data, 'base64')).metadata();
        assert.equal(decoded.format, 'png');
        assert.equal(decoded.exif, undefined);
      }
      const huge = await sharp({
        create: { width: 6000, height: 4000, channels: 3, background: 'white' },
      })
        .png()
        .toBuffer();
      await assert.rejects(f.put('huge.png', huge), /pixel|像素|limit/i);
      await assert.rejects(
        f.put('broken.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])),
        /image|png|header|corrupt/i,
      );
    } finally {
      await f.close();
    }
  },
);
