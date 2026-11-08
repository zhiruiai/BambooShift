import {
  filePreviewKind,
  previewBlobMime,
  previewExtension,
  previewMimeAllowed,
  validDocumentHeader,
  type OfficePreviewFormat,
} from './filePreviewFormat';

export { filePreviewKind, type FilePreviewKind } from './filePreviewFormat';
export const FILE_PREVIEW_LIMIT = 2 * 1024 * 1024;
export const BINARY_PREVIEW_LIMIT = 10 * 1024 * 1024;
export type FilePreviewIdentity = { userId?: string; workspaceId?: string; pathname: string };
export type FormattedFilePreviewContent =
  | { kind: 'markdown'; text: string }
  | { kind: 'table'; text: string; delimiter: ',' | '\t' }
  | { kind: 'audio' | 'video'; url: string }
  | { kind: 'pdf'; bytes: Uint8Array }
  | { kind: 'office'; format: OfficePreviewFormat; bytes: Uint8Array };
export type FilePreviewContent =
  | { kind: 'html'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string }
  | FormattedFilePreviewContent;
export type FilePreviewState =
  | { status: 'loading' | 'unsupported' }
  | { status: 'ready'; content: FilePreviewContent }
  | { status: 'error'; code: PreviewErrorCode };
type PreviewErrorCode = 'access' | 'large' | 'type' | 'network' | 'scope';

export class FilePreviewError extends Error {
  constructor(readonly code: PreviewErrorCode) {
    super(code);
  }
}

export function previewFilePath(href: string, identity: FilePreviewIdentity): string | undefined {
  const match =
    /^\/api\/(?:workspaces\/([a-f0-9-]{36})\/)?files\/([A-Za-z0-9_-]{1,128})\/download$/.exec(href);
  if (!match || match[1] !== identity.workspaceId) return;
  if (identity.workspaceId && !identity.userId) return;
  const pageWorkspace = /^\/w\/([a-f0-9-]{36})(?:\/|$)/.exec(identity.pathname)?.[1];
  if (pageWorkspace !== identity.workspaceId) return;
  return href;
}

function sameIdentity(a: FilePreviewIdentity, b: FilePreviewIdentity) {
  return a.userId === b.userId && a.workspaceId === b.workspaceId && a.pathname === b.pathname;
}

export async function readBoundedBody(
  response: Response,
  limit: number,
  check: () => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => {});
    throw new FilePreviewError('large');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      check();
      const { done, value } = await reader.read();
      check();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new FilePreviewError('large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function createFilePreview(options: {
  href: string;
  name: string;
  identity: FilePreviewIdentity;
  currentIdentity: () => FilePreviewIdentity;
  onChange: (state: FilePreviewState) => void;
  fetch?: typeof fetch;
  objectUrls?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
}) {
  let active = true;
  let generation = 0;
  let controller: AbortController | undefined;
  let objectUrl: string | undefined;
  const urls = options.objectUrls || URL;
  const path = previewFilePath(options.href, options.identity);
  const current = () =>
    active && !!path && sameIdentity(options.identity, options.currentIdentity());
  const clear = () => {
    controller?.abort();
    if (objectUrl) urls.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  };
  return {
    current,
    async load() {
      clear();
      const epoch = ++generation;
      const requestController = new AbortController();
      controller = requestController;
      const signal = requestController.signal;
      let response: Response | undefined;
      const check = () => {
        if (!current() || signal.aborted || epoch !== generation)
          throw new FilePreviewError('scope');
      };
      const publish = (state: FilePreviewState) => {
        if (current() && epoch === generation) options.onChange(state);
      };
      try {
        check();
        const kind = filePreviewKind(options.name);
        if (kind === 'unsupported') return publish({ status: 'unsupported' });
        publish({ status: 'loading' });
        response = await (options.fetch || fetch)(path!, {
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal,
          headers: options.identity.userId
            ? { 'X-OpenBot-Expected-User': options.identity.userId }
            : {},
        });
        check();
        if (!response.ok || response.redirected) {
          await response.body?.cancel().catch(() => {});
          throw new FilePreviewError(
            [401, 403, 404].includes(response.status) ? 'access' : 'network',
          );
        }
        if (!/^attachment(?:;|$)/i.test(response.headers.get('content-disposition') || '')) {
          await response.body?.cancel().catch(() => {});
          throw new FilePreviewError('type');
        }
        const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        const ext = previewExtension(options.name);
        if (!previewMimeAllowed(kind, ext, mime)) {
          await response.body?.cancel().catch(() => {});
          throw new FilePreviewError('type');
        }
        const limit =
          kind === 'pdf' || kind === 'office' || kind === 'audio' || kind === 'video'
            ? BINARY_PREVIEW_LIMIT
            : FILE_PREVIEW_LIMIT;
        const bytes = await readBoundedBody(response, limit, check);
        check();
        if (kind === 'image' || kind === 'audio' || kind === 'video') {
          const detected = previewBlobMime(kind, ext, bytes);
          if (!detected) throw new FilePreviewError('type');
          objectUrl = urls.createObjectURL(
            new Blob([bytes as Uint8Array<ArrayBuffer>], { type: detected }),
          );
          publish({ status: 'ready', content: { kind, url: objectUrl } });
          return;
        }
        if (kind === 'pdf' || kind === 'office') {
          if (!validDocumentHeader(kind, bytes)) throw new FilePreviewError('type');
          const content: FilePreviewContent =
            kind === 'office'
              ? { kind, format: ext as OfficePreviewFormat, bytes }
              : { kind, bytes };
          publish({ status: 'ready', content });
          return;
        }
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new FilePreviewError('type');
        }
        if (text.includes('\0')) throw new FilePreviewError('type');
        const content: FilePreviewContent =
          kind === 'table' ? { kind, text, delimiter: ext === 'tsv' ? '\t' : ',' } : { kind, text };
        publish({ status: 'ready', content });
      } catch (error) {
        requestController.abort();
        await response?.body?.cancel().catch(() => {});
        publish({
          status: 'error',
          code: error instanceof FilePreviewError ? error.code : 'network',
        });
      }
    },
    close() {
      active = false;
      generation++;
      clear();
    },
  };
}
