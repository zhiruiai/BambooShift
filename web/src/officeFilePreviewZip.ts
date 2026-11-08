const entryLimit = 1000;
const inputLimit = 10 * 1024 * 1024;
const entrySizeLimit = 8 * 1024 * 1024;
const archiveSizeLimit = 40 * 1024 * 1024;
const xmlSizeLimit = 4 * 1024 * 1024;
const xmlBudget = 12 * 1024 * 1024;
const endSignature = 0x06054b50;
const directorySignature = 0x02014b50;
const entrySignature = 0x04034b50;
const descriptorSignature = 0x08074b50;
const supportedFlags = 0x080e;

type Entry = {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  start: number;
};

export function invalidOfficeFile(): never {
  throw new Error('Invalid or unsupported Office file');
}

function endRecord(view: DataView) {
  const earliest = Math.max(0, view.byteLength - 22 - 65535);
  for (let offset = view.byteLength - 22; offset >= earliest; offset--) {
    if (
      view.getUint32(offset, true) === endSignature &&
      offset + 22 + view.getUint16(offset + 20, true) === view.byteLength
    ) {
      return offset;
    }
  }
  return invalidOfficeFile();
}

function validPartName(name: string) {
  const path = name.endsWith('/') ? name.slice(0, -1) : name;
  return (
    path.length <= 512 &&
    !/[\\:\u0000-\u001f\u007f]/u.test(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

function localData(
  entry: Entry,
  limit: number,
  view: DataView,
  readName: (start: number, length: number) => string,
) {
  const { offset, flags, method, crc, compressed, size } = entry;
  if (
    offset + 30 > limit ||
    view.getUint32(offset, true) !== entrySignature ||
    view.getUint16(offset + 6, true) !== flags ||
    view.getUint16(offset + 8, true) !== method
  ) {
    invalidOfficeFile();
  }
  const nameLength = view.getUint16(offset + 26, true);
  const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
  const end = start + compressed;
  if (end > limit || readName(offset + 30, nameLength) !== entry.name) invalidOfficeFile();
  if (!(flags & 8)) {
    if (
      view.getUint32(offset + 14, true) !== crc ||
      view.getUint32(offset + 18, true) !== compressed ||
      view.getUint32(offset + 22, true) !== size ||
      end !== limit
    ) {
      invalidOfficeFile();
    }
  } else {
    const signature = limit - end === 16 && view.getUint32(end, true) === descriptorSignature;
    const descriptor = end + (signature ? 4 : 0);
    if (
      descriptor + 12 !== limit ||
      view.getUint32(descriptor, true) !== crc ||
      view.getUint32(descriptor + 4, true) !== compressed ||
      view.getUint32(descriptor + 8, true) !== size
    ) {
      invalidOfficeFile();
    }
  }
  entry.start = start;
}

function directory(bytes: Uint8Array) {
  if (bytes.byteLength < 22 || bytes.byteLength > inputLimit) invalidOfficeFile();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endRecord(view);
  const count = view.getUint16(end + 10, true);
  const first = view.getUint32(end + 16, true);
  if (
    view.getUint32(end + 4, true) !== 0 ||
    view.getUint16(end + 8, true) !== count ||
    !count ||
    count > entryLimit ||
    first + view.getUint32(end + 12, true) !== end
  ) {
    invalidOfficeFile();
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const readName = (start: number, length: number) =>
    decoder.decode(bytes.subarray(start, start + length));
  const entries = new Map<string, Entry>();
  let total = 0;
  let cursor = first;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== directorySignature) {
      invalidOfficeFile();
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const next =
      cursor +
      46 +
      nameLength +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
    total += size;
    if (
      next > end ||
      (flags & ~supportedFlags) !== 0 ||
      (method !== 0 && method !== 8) ||
      (method === 0 && size !== compressed) ||
      view.getUint16(cursor + 34, true) !== 0 ||
      size > entrySizeLimit ||
      total > archiveSizeLimit ||
      (size > 1024 * 1024 && size > compressed * 500)
    ) {
      invalidOfficeFile();
    }
    const name = readName(cursor + 46, nameLength);
    const key = name.toLowerCase();
    if (!validPartName(name) || entries.has(key)) invalidOfficeFile();
    entries.set(key, {
      name,
      flags,
      method,
      crc: view.getUint32(cursor + 16, true),
      compressed,
      size,
      offset: view.getUint32(cursor + 42, true),
      start: 0,
    });
    cursor = next;
  }
  if (cursor !== end) invalidOfficeFile();
  const ordered = [...entries.values()].sort((a, b) => a.offset - b.offset);
  if (ordered[0].offset !== 0) invalidOfficeFile();
  ordered.forEach((entry, index) =>
    localData(entry, ordered[index + 1]?.offset ?? first, view, readName),
  );
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ (byte & 1 ? 0xedb88320 : 0);
  return byte;
});

function checksum(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflate(bytes: Uint8Array, size: number, signal: AbortSignal) {
  const output = new Uint8Array(size);
  let inputOffset = 0;
  // Small input chunks limit how much output an inflater can queue before the size check.
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (inputOffset === bytes.length) {
        controller.close();
      } else {
        const end = Math.min(inputOffset + 1024, bytes.length);
        controller.enqueue(bytes.slice(inputOffset, end));
        inputOffset = end;
      }
    },
  });
  const reader = input.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  try {
    let offset = 0;
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (offset + value.length > size) invalidOfficeFile();
      output.set(value, offset);
      offset += value.length;
    }
    if (offset !== size) invalidOfficeFile();
    return output;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export function openOfficeZip(bytes: Uint8Array, signal: AbortSignal) {
  signal.throwIfAborted();
  const entries = directory(bytes);
  let remaining = xmlBudget;
  return {
    has: (path: string) => entries.has(path.toLowerCase()),
    async readXml(path: string) {
      signal.throwIfAborted();
      const entry = entries.get(path.toLowerCase());
      if (!entry || entry.size > xmlSizeLimit || entry.size > remaining) invalidOfficeFile();
      remaining -= entry.size;
      const source = bytes.subarray(entry.start, entry.start + entry.compressed);
      const expanded = entry.method === 0 ? source : await inflate(source, entry.size, signal);
      if (checksum(expanded) !== entry.crc) invalidOfficeFile();
      const encoding =
        expanded[0] === 0xff && expanded[1] === 0xfe
          ? 'utf-16le'
          : expanded[0] === 0xfe && expanded[1] === 0xff
            ? 'utf-16be'
            : 'utf-8';
      return new TextDecoder(encoding, { fatal: true }).decode(expanded);
    },
  };
}
