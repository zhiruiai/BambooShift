import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { ATTACHMENT_LIMITS, type TextAttachment, type AttachmentResult } from './contract.ts';
import { parsePdf, parseDocx, parseImage } from './formats.ts';

const textExtensions = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.sh',
  '.log',
  '.sql',
  '.toml',
  '.ini',
  '.rs',
  '.go',
  '.svg',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.m',
  '.mm',
  '.r',
  '.rb',
  '.php',
  '.lua',
  '.pl',
  '.ps1',
  '.bash',
  '.zsh',
  '.fish',
  '.vue',
  '.svelte',
  '.scss',
  '.sass',
  '.less',
  '.graphql',
  '.gql',
  '.proto',
  '.ipynb',
  '.lock',
  '.conf',
  '.cfg',
  '.properties',
  '.gradle',
  '.cmake',
]);

export function sourceType(name: string, bytes: Buffer): string {
  const ext = extname(name).toLowerCase();
  if (ext === '.pdf') {
    if (!bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-'))
      throw new Error('PDF 文件头无效，文件可能损坏。');
    return 'application/pdf';
  }
  if (ext === '.docx') {
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
      throw new Error('DOCX 文件头无效，文件可能损坏。');
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (ext === '.png') {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('PNG 文件头无效。');
    return 'image/png';
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255)
      throw new Error('JPEG 文件头无效。');
    return 'image/jpeg';
  }
  if (ext === '.webp') {
    if (
      bytes.length < 12 ||
      bytes.subarray(0, 4).toString() !== 'RIFF' ||
      bytes.subarray(8, 12).toString() !== 'WEBP' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length
    )
      throw new Error('WebP 文件头无效。');
    return 'image/webp';
  }
  if (!ext || textExtensions.has(ext)) return 'text/plain';
  throw new Error('暂不支持此附件格式。支持 PDF、DOCX、PNG、JPEG、WebP 和常见 UTF-8 文本。');
}

export function parseText(name: string, bytes: Buffer): TextAttachment {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('附件不是有效 UTF-8 文本，不能将二进制内容当作正文。');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
    throw new Error('附件包含二进制控制字符，不能当作文本读取。');
  const truncated = text.length > ATTACHMENT_LIMITS.textCharacters;
  return {
    kind: 'text',
    name,
    mimeType: 'text/plain',
    sourceMimeType: 'text/plain',
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    text: text.slice(0, ATTACHMENT_LIMITS.textCharacters),
    truncated,
    warnings: truncated ? ['正文超过 120,000 字符，已截断。'] : [],
  };
}

export async function parseAuthorizedBytes(name: string, bytes: Buffer): Promise<AttachmentResult> {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 4096 ||
    name.includes('\0') ||
    basename(name) !== name
  )
    throw new Error('附件名称无效。');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > ATTACHMENT_LIMITS.inputBytes)
    throw new Error('附件为空或超过 10 MiB。');
  const sourceMimeType = sourceType(name, bytes);
  const input = { name, bytes, sourceMimeType };
  if (sourceMimeType === 'text/plain') return parseText(name, bytes);
  if (sourceMimeType === 'application/pdf') return parsePdf(input);
  if (sourceMimeType.startsWith('image/')) return parseImage(input);
  return parseDocx(input);
}
