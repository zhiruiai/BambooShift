import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const machine = { x64: { macho: 0x01000007, elf: 62 }, arm64: { macho: 0x0100000c, elf: 183 } };
const invalid = (platform, arch) =>
  Error(`Native executable does not match target ${platform}/${arch}.`);

/** Check executable format/ISA without executing or loading an unverified build output. */
export async function validateNativeBinary(path, { platform, arch }) {
  if (!['darwin', 'linux'].includes(platform) || !Object.hasOwn(machine, arch))
    throw invalid(platform, arch);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw invalid(platform, arch);
    const read = async (position, length) => {
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await file.read(bytes, 0, length, position);
      return bytes.subarray(0, bytesRead);
    };
    const header = await read(0, 4096);
    const matchesMachO = (bytes) =>
      bytes.length >= 32 &&
      bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === machine[arch].macho &&
      bytes.readUInt32LE(12) === 2;
    if (platform === 'linux') {
      if (
        header.length < 64 ||
        !header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
        header[4] !== 2 ||
        header[5] !== 1 ||
        header[6] !== 1 ||
        ![2, 3].includes(header.readUInt16LE(16)) ||
        header.readUInt16LE(18) !== machine[arch].elf ||
        header.readUInt32LE(20) !== 1
      )
        throw invalid(platform, arch);
      return;
    }
    if (matchesMachO(header)) return;
    if (header.length < 8) throw invalid(platform, arch);
    const magic = header.readUInt32BE(0);
    const fat = {
      0xcafebabe: { little: false, wide: false },
      0xcafebabf: { little: false, wide: true },
      0xbebafeca: { little: true, wide: false },
      0xbfbafeca: { little: true, wide: true },
    }[magic];
    if (!fat) throw invalid(platform, arch);
    const u32 = (offset) =>
      fat.little ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
    const u64 = (offset) => {
      const value = fat.little ? header.readBigUInt64LE(offset) : header.readBigUInt64BE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid(platform, arch);
      return Number(value);
    };
    const count = u32(4),
      entrySize = fat.wide ? 32 : 20,
      tableSize = 8 + count * entrySize;
    if (!count || count > 64 || tableSize > header.length) throw invalid(platform, arch);
    let matched = false;
    for (let index = 0; index < count; index++) {
      const entry = 8 + index * entrySize;
      const offset = fat.wide ? u64(entry + 8) : u32(entry + 8);
      const size = fat.wide ? u64(entry + 16) : u32(entry + 12);
      if (offset < tableSize || size < 32 || offset > stat.size - size)
        throw invalid(platform, arch);
      if (u32(entry) === machine[arch].macho) {
        if (!matchesMachO(await read(offset, 32))) throw invalid(platform, arch);
        matched = true;
      }
    }
    if (!matched) throw invalid(platform, arch);
  } finally {
    await file.close();
  }
}
