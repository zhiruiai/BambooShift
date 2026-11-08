export type OfficePreviewFormat = 'docx' | 'xlsx' | 'pptx';
export type FilePreviewKind =
  | 'html'
  | 'markdown'
  | 'text'
  | 'table'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'office'
  | 'unsupported';

const images = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);
const audio = new Map([
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['m4a', 'audio/mp4'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/ogg'],
  ['flac', 'audio/flac'],
]);
const video = new Map([
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['ogv', 'video/ogg'],
]);
const office = new Map<OfficePreviewFormat, string>([
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);
const textExtensions = new Set(
  (
    'txt json jsonl ndjson log yaml yml xml toml ini conf ' +
    'js mjs cjs jsx ts tsx css sql sh bash zsh py rb rs go c cc cpp h hpp java kt swift ps1'
  ).split(' '),
);
const textMimes =
  /^(?:text\/(?:plain|markdown|x-markdown|csv|tab-separated-values|yaml|x-yaml|xml|javascript|typescript|css|sql|x-(?:python|shellscript|rust|c|c\+\+|java|go|ruby))|application\/(?:json|(?:x-)?ndjson|xml|yaml|x-yaml|javascript|typescript|toml|sql|x-sh))$/;

export function previewExtension(name: string): string {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() || '';
}

export function filePreviewKind(name: string): FilePreviewKind {
  const ext = previewExtension(name);
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'csv' || ext === 'tsv') return 'table';
  if (images.has(ext)) return 'image';
  if (audio.has(ext)) return 'audio';
  if (video.has(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  if (office.has(ext as OfficePreviewFormat)) return 'office';
  if (textExtensions.has(ext)) return 'text';
  return 'unsupported';
}

export function previewMimeAllowed(
  kind: Exclude<FilePreviewKind, 'unsupported'>,
  ext: string,
  mime: string | undefined,
): boolean {
  if (!mime || mime === 'application/octet-stream') return true;
  switch (kind) {
    case 'html':
      return mime === 'text/html' || mime === 'text/plain';
    case 'table':
    case 'markdown':
    case 'text':
      return textMimes.test(mime);
    case 'image':
      return images.get(ext) === mime;
    case 'audio':
      return (
        audio.get(ext) === mime ||
        (ext === 'wav' && ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(mime)) ||
        (ext === 'm4a' && mime === 'audio/x-m4a') ||
        (ext === 'mp3' && mime === 'audio/mp3') ||
        (ext === 'flac' && mime === 'audio/x-flac') ||
        (['oga', 'ogg', 'opus'].includes(ext) && mime === 'application/ogg')
      );
    case 'video':
      return video.get(ext) === mime || (ext === 'ogv' && mime === 'application/ogg');
    case 'pdf':
      return mime === 'application/pdf';
    case 'office':
      return mime === office.get(ext as OfficePreviewFormat) || mime === 'application/zip';
  }
}

const signature = (bytes: Uint8Array, offset: number, expected: number[]) =>
  expected.every((byte, index) => bytes[offset + index] === byte);
const hasText = (bytes: Uint8Array, offset: number, text: string) =>
  [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
type Size = [width: number, height: number];

function jpegSize(bytes: Uint8Array, view: DataView): Size | undefined {
  if (!signature(bytes, 0, [255, 216])) return;
  const limit = Math.min(bytes.length, 1024 * 1024);
  for (let i = 2; i + 4 <= limit;) {
    if (bytes[i++] !== 255) return;
    while (i < limit && bytes[i] === 255) i++;
    const marker = bytes[i++];
    if (marker === 0xda || marker === 0xd9 || i + 2 > limit) return;
    const length = view.getUint16(i);
    if (length < 2 || i + length > limit) return;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (length < 8) return;
      return [view.getUint16(i + 5), view.getUint16(i + 3)];
    }
    i += length;
  }
}

function webpSize(bytes: Uint8Array, view: DataView): Size | undefined {
  if (!hasText(bytes, 0, 'RIFF') || !hasText(bytes, 8, 'WEBP') || bytes.length < 30) return;
  if (hasText(bytes, 12, 'VP8X')) {
    const read24 = (i: number) => bytes[i] + bytes[i + 1] * 256 + bytes[i + 2] * 65536;
    return [read24(24) + 1, read24(27) + 1];
  }
  if (hasText(bytes, 12, 'VP8 ') && signature(bytes, 23, [0x9d, 1, 0x2a]))
    return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
  if (hasText(bytes, 12, 'VP8L') && bytes[20] === 0x2f) {
    const size = view.getUint32(21, true);
    return [(size & 0x3fff) + 1, ((size >>> 14) & 0x3fff) + 1];
  }
}

function imageSize(ext: string, bytes: Uint8Array): Size | undefined {
  const view = viewOf(bytes);
  switch (ext) {
    case 'png':
      if (
        bytes.length >= 24 &&
        signature(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
        view.getUint32(8) === 13 &&
        hasText(bytes, 12, 'IHDR')
      )
        return [view.getUint32(16), view.getUint32(20)];
      return;
    case 'jpg':
    case 'jpeg':
      return jpegSize(bytes, view);
    case 'gif':
      if (bytes.length >= 13 && (hasText(bytes, 0, 'GIF87a') || hasText(bytes, 0, 'GIF89a')))
        return [view.getUint16(6, true), view.getUint16(8, true)];
      return;
    case 'webp':
      return webpSize(bytes, view);
  }
}

function mediaHeader(ext: string, bytes: Uint8Array): boolean {
  switch (ext) {
    case 'mp3':
      return (
        (bytes.length >= 10 && hasText(bytes, 0, 'ID3') && bytes[3] >= 2 && bytes[3] <= 4) ||
        (bytes.length >= 4 &&
          bytes[0] === 255 &&
          (bytes[1] & 0xe0) === 0xe0 &&
          (bytes[1] & 0x18) !== 0x08 &&
          (bytes[1] & 0x06) !== 0 &&
          (bytes[2] & 0xf0) !== 0xf0 &&
          (bytes[2] & 0x0c) !== 0x0c)
      );
    case 'wav':
      return hasText(bytes, 0, 'RIFF') && hasText(bytes, 8, 'WAVE');
    case 'flac':
      return hasText(bytes, 0, 'fLaC');
    case 'ogg':
    case 'oga':
    case 'opus':
    case 'ogv':
      return hasText(bytes, 0, 'OggS') && bytes[4] === 0;
    case 'mp4':
    case 'm4a':
      return bytes.length >= 16 && hasText(bytes, 4, 'ftyp') && viewOf(bytes).getUint32(0) >= 16;
    case 'webm':
      return (
        signature(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3]) &&
        bytes.subarray(4, 64).some((_, index) => hasText(bytes, index + 4, 'webm'))
      );
    default:
      return false;
  }
}

export function previewBlobMime(
  kind: 'image' | 'audio' | 'video',
  ext: string,
  bytes: Uint8Array,
): string | undefined {
  if (kind === 'image') {
    const [width, height] = imageSize(ext, bytes) ?? [0, 0];
    if (width && height && width <= 16384 && height <= 16384 && width * height <= 32_000_000)
      return images.get(ext);
    return;
  }
  if (mediaHeader(ext, bytes)) return (kind === 'audio' ? audio : video).get(ext);
}

export function validDocumentHeader(kind: 'pdf' | 'office', bytes: Uint8Array): boolean {
  if (kind === 'pdf') return hasText(bytes, 0, '%PDF-');
  return signature(bytes, 0, [0x50, 0x4b, 0x03, 0x04]);
}
