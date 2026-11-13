import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { ATTACHMENT_LIMITS, type AttachmentResult } from '../contract.ts';
import { parseAuthorizedBytes } from '../parse.ts';

export const blockSize = 64;
export const palette = [
  [40, 40, 40],
  [200, 200, 200],
  [170, 70, 65],
  [70, 150, 80],
  [65, 85, 170],
  [140, 100, 155],
];

export function colourGrid() {
  const width = 3 * blockSize;
  const height = 2 * blockSize;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(
        palette[Math.floor(y / blockSize) * 3 + Math.floor(x / blockSize)],
        (y * width + x) * 3,
      );
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } });
}

export async function orientedImage(format: 'png' | 'jpeg' | 'webp', orientation: number) {
  const image = colourGrid().withMetadata({ orientation });
  if (format === 'jpeg') return image.jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
  if (format === 'webp') return image.webp({ lossless: true }).toBuffer();
  return image.png().toBuffer();
}

export function solidPng(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#4589ff' } })
    .png()
    .toBuffer();
}

export function animatedWebp() {
  // Two 2x1 pages, red then blue; pageHeight makes this an actual multi-frame file.
  return sharp(Buffer.from([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]), {
    raw: { width: 2, height: 2, channels: 3, pageHeight: 1 },
  })
    .webp({ lossless: true, loop: 0, delay: [100, 100] })
    .toBuffer();
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

export function apng(separatePoster: boolean) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2; // RGB, no interlace.
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2);
  const frame = (sequence: number) => {
    const control = Buffer.alloc(26);
    control.writeUInt32BE(sequence, 0);
    control.writeUInt32BE(2, 4);
    control.writeUInt32BE(1, 8);
    control.writeUInt16BE(1, 20);
    control.writeUInt16BE(10, 22);
    return pngChunk('fcTL', control);
  };
  const pixels = (rgb: number[]) => deflateSync(Buffer.from([0, ...rgb, ...rgb]));
  const frameData = (sequence: number, rgb: number[]) => {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(sequence);
    return pngChunk('fdAT', Buffer.concat([counter, pixels(rgb)]));
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('acTL', animation),
    ...(separatePoster ? [] : [frame(0)]),
    pngChunk('IDAT', pixels([255, 0, 0])),
    ...(separatePoster
      ? [frame(0), frameData(1, [0, 255, 0]), frame(2), frameData(3, [0, 0, 255])]
      : [frame(1), frameData(2, [0, 255, 0])]),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function padPng(bytes: Buffer, size: number) {
  // Private ancillary data preserves a fully valid image at the byte limit.
  assert.ok(size >= bytes.length + 12);
  return Buffer.concat([
    bytes.subarray(0, -12),
    pngChunk('paDd', Buffer.alloc(size - bytes.length - 12)),
    bytes.subarray(-12),
  ]);
}

export async function noisyJpeg() {
  let state = 0x12345678;
  const bytes = Buffer.alloc(2048 * 2048 * 3);
  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return sharp(bytes, { raw: { width: 2048, height: 2048, channels: 3 } })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

interface Target {
  label: string;
  parse(name: string, bytes: Buffer): Promise<AttachmentResult>;
}

function workerParser(runtime: string, node: string): Target['parse'] {
  return async (name, bytes) => {
    const child = spawn(
      node,
      ['--max-old-space-size=192', join(runtime, 'packages/document-worker/index.mjs')],
      {
        cwd: runtime,
        env: { LANG: process.env.LANG ?? 'en_US.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const chunks: Buffer[] = [];
    let length = 0;
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const closed = new Promise<number | null>((done) => {
      child.once('error', fail);
      child.once('close', done);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 12 * 1024 * 1024)
        fail(new Error('Worker stdout exceeds the production envelope limit'));
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') fail(error);
    });
    const timer = setTimeout(
      () => fail(new Error('Compiled worker timed out')),
      ATTACHMENT_LIMITS.timeoutMs,
    );
    try {
      child.stdin.end(JSON.stringify({ version: 1, name, data: bytes.toString('base64') }));
      const code = await closed;
      if (failure) throw failure;
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(envelope.version, 1);
      if (!envelope.ok) {
        assert.equal(envelope.ok, false);
        assert.equal(code, 1);
        assert.equal(envelope.code, 'DOCUMENT_INVALID');
        assert.equal(envelope.error, '附件解析失败，文件可能损坏、不受支持或超过限制。');
        throw new Error(envelope.error);
      }
      assert.equal(envelope.ok, true);
      assert.equal(code, 0);
      return envelope.result as AttachmentResult;
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  };
}

export async function contractTargets() {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const external = process.env.OPENBOT_IMAGE_CONTRACT_RUNTIME;
  const node = process.env.OPENBOT_IMAGE_CONTRACT_NODE ?? process.execPath;
  const runtime = external ? resolve(external) : await mkdtemp(join(tmpdir(), 'image-contract-'));
  const close = async () => {
    if (!external) await rm(runtime, { recursive: true, force: true });
  };
  try {
    if (!external) {
      // Use the release builder and its real document entry, not a test-only bundle.
      await promisify(execFile)(process.execPath, ['scripts/build-workers.mjs', '--out', runtime], {
        cwd: root,
        timeout: 30_000,
      });
      await symlink(join(root, 'node_modules'), join(runtime, 'node_modules'), 'dir');
    } else {
      const entry = join(runtime, 'packages/document-worker/index.mjs');
      const sharpPath = await realpath(createRequire(entry).resolve('sharp'));
      const dependencyRoot = join(await realpath(runtime), 'node_modules') + sep;
      assert.ok(
        sharpPath.startsWith(dependencyRoot),
        'External acceptance must resolve Sharp inside that runtime',
      );
    }
    return {
      targets: [
        { label: 'source parser', parse: parseAuthorizedBytes },
        {
          label: external
            ? `external compiled runtime: ${runtime}`
            : 'release-builder compiled worker',
          parse: workerParser(runtime, node),
        },
      ] satisfies Target[],
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
