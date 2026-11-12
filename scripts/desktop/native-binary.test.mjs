import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateNativeBinary } from './native-binary.mjs';

function macho(arch) {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  return bytes;
}
function elf(arch) {
  const bytes = Buffer.alloc(64);
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
  bytes.writeUInt32LE(1, 20);
  return bytes;
}
function universal(wide = false, little = false) {
  const bytes = Buffer.alloc(384);
  const u32 = (value, offset) =>
    little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  const u64 = (value, offset) =>
    little
      ? bytes.writeBigUInt64LE(BigInt(value), offset)
      : bytes.writeBigUInt64BE(BigInt(value), offset);
  u32(wide ? 0xcafebabf : 0xcafebabe, 0);
  u32(2, 4);
  for (const [index, arch] of ['x64', 'arm64'].entries()) {
    const entry = 8 + index * (wide ? 32 : 20),
      offset = 128 + index * 128;
    u32(arch === 'x64' ? 0x01000007 : 0x0100000c, entry);
    if (wide) {
      u64(offset, entry + 8);
      u64(64, entry + 16);
    } else {
      u32(offset, entry + 8);
      u32(64, entry + 12);
    }
    macho(arch).copy(bytes, offset);
  }
  return bytes;
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'native-binary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'executable');
  return {
    file,
    async check(bytes, platform, arch) {
      await writeFile(file, bytes, { mode: 0o755 });
      return validateNativeBinary(file, { platform, arch });
    },
  };
}

test('native package validation distinguishes Linux/macOS, CPU architecture and executable headers', async (t) => {
  const f = await fixture(t);
  for (const arch of ['x64', 'arm64']) {
    await f.check(macho(arch), 'darwin', arch);
    await f.check(elf(arch), 'linux', arch);
    const other = arch === 'x64' ? 'arm64' : 'x64';
    await assert.rejects(f.check(macho(other), 'darwin', arch), /target/);
    await assert.rejects(f.check(elf(other), 'linux', arch), /target/);
    await assert.rejects(f.check(elf(arch), 'darwin', arch), /target/);
    await assert.rejects(f.check(macho(arch), 'linux', arch), /target/);
  }
  const library = macho('arm64');
  library.writeUInt32LE(6, 12);
  await assert.rejects(f.check(library, 'darwin', 'arm64'), /target/);
  await assert.rejects(f.check(Buffer.from('#!/bin/sh\n'), 'darwin', 'arm64'), /target/);
});

test('universal Mach-O validates the actual selected slices and bounded fat tables', async (t) => {
  const f = await fixture(t);
  for (const wide of [false, true])
    for (const little of [false, true]) {
      for (const arch of ['arm64', 'x64']) await f.check(universal(wide, little), 'darwin', arch);
    }
  const wrongSlice = universal();
  macho('x64').copy(wrongSlice, 256);
  await assert.rejects(f.check(wrongSlice, 'darwin', 'arm64'), /target/);
  const oversized = universal();
  oversized.writeUInt32BE(1000, 4);
  await assert.rejects(f.check(oversized, 'darwin', 'arm64'), /target/);
  const escaped = universal();
  escaped.writeUInt32BE(10_000, 36);
  await assert.rejects(f.check(escaped, 'darwin', 'arm64'), /target/);
  const truncated = universal().subarray(0, 100);
  await assert.rejects(f.check(truncated, 'darwin', 'arm64'), /target/);
});

test(
  'native validation rejects unsupported targets and redirected binaries',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    await f.check(macho('arm64'), 'darwin', 'arm64');
    await assert.rejects(
      validateNativeBinary(f.file, { platform: 'win32', arch: 'x64' }),
      /target/,
    );
    const link = f.file + '.link';
    await symlink(f.file, link);
    await assert.rejects(validateNativeBinary(link, { platform: 'darwin', arch: 'arm64' }));
  },
);
