import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import sharp from 'sharp';
import { pdfFixture, docxFixture } from './fixtures.ts';

async function worker(name: string, bytes: Buffer, fields: Record<string, unknown> = {}) {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--max-old-space-size=192',
      new URL('./index.ts', import.meta.url).pathname,
    ],
    {
      env: { LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const exited = once(child, 'close');
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    child.stdin.end(
      JSON.stringify({ version: 1, name, data: bytes.toString('base64'), ...fields }),
    );
    await exited;
    return JSON.parse(output);
  } finally {
    clearTimeout(timeout);
  }
}

test('disposable worker extracts real PDF and Chinese DOCX bytes without caller paths', async () => {
  const pdf = await worker('report.pdf', pdfFixture('Synthetic PDF document', 2));
  assert.equal(pdf.ok, true);
  assert.match(pdf.result.text, /Synthetic PDF document page 2/);
  assert.equal(pdf.result.pageCount, 2);
  const docx = await worker('plan.docx', docxFixture('真实中文合成资料。'));
  assert.equal(docx.ok, true);
  assert.match(docx.result.text, /真实中文合成资料/);
  const path = await worker('../private.docx', docxFixture('Blocked path'));
  assert.equal(path.ok, false);
  const extra = await worker('plain.txt', Buffer.from('Safe bytes'), { path: '/private/anything' });
  assert.equal(extra.ok, false);
});

test('actual image bytes are normalized to metadata-free PNG and CSV receives a full-byte digest', async () => {
  const bytes = await sharp({
    create: { width: 36, height: 24, channels: 3, background: '#8866bb' },
  })
    .jpeg()
    .withMetadata()
    .toBuffer();
  const image = await worker('picture.jpeg', bytes);
  assert.equal(image.ok, true);
  assert.equal(image.result.mimeType, 'image/png');
  const normalized = await sharp(Buffer.from(image.result.data, 'base64')).metadata();
  assert.equal(normalized.width, 36);
  assert.equal(normalized.height, 24);
  assert.equal(normalized.exif, undefined);
  const csv = await worker('report.csv', Buffer.from('姓名,数量\n合成用户,2\n'));
  assert.equal(csv.result.text, '姓名,数量\n合成用户,2\n');
  assert.match(csv.result.sha256, /^[a-f0-9]{64}$/);
});

test('codec rejects unsafe documents, binary text and decoded-image limits', async () => {
  assert.equal((await worker('broken.pdf', Buffer.from('%PDF-1.4 broken'))).ok, false);
  assert.equal((await worker('binary.csv', Buffer.from([0, 255, 1]))).ok, false);
  const entities = docxFixture('safe', {
    'word/extra.xml': '<!DOCTYPE a [<!ENTITY x "sensitive">]><a>&x;</a>',
  });
  assert.equal((await worker('entities.docx', entities)).ok, false);
  const big = await sharp({
    create: { width: 6000, height: 4000, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  assert.equal((await worker('large.png', big)).ok, false);
});
