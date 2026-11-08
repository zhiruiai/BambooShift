export const ATTACHMENT_LIMITS = Object.freeze({
  inputBytes: 10 * 1024 * 1024,
  textCharacters: 120_000,
  pdfPages: 100,
  zipEntries: 1000,
  zipEntryBytes: 8 * 1024 * 1024,
  zipExpandedBytes: 30 * 1024 * 1024,
  imagePixels: 20_000_000,
  imageSide: 12_000,
  imageOutputSide: 2048,
  imageOutputBytes: 8 * 1024 * 1024,
  timeoutMs: 20_000,
});

interface AttachmentBase {
  name: string;
  mimeType: string;
  sourceMimeType: string;
  byteLength: number;
  truncated: boolean;
  warnings: string[];
}
export interface TextAttachment extends AttachmentBase {
  kind: 'text';
  text: string;
  pageCount?: number;
  pagesRead?: number;
  sha256?: string;
}
export interface ImageAttachment extends AttachmentBase {
  kind: 'image';
  mimeType: 'image/png';
  data: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}
export type AttachmentResult = TextAttachment | ImageAttachment;
export interface ReadAttachmentOptions {
  workspaceDir: string;
  path: string;
  signal?: AbortSignal;
}
export interface ReadAttachmentBytesOptions {
  name: string;
  bytes: Buffer;
  signal?: AbortSignal;
}

export interface ParseInput {
  name: string;
  bytes: Buffer;
  sourceMimeType: string;
}
