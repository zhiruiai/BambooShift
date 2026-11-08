import { uiText } from './i18n';
import type {
  SharedBotFileGrant,
  SharedBotFileSelection,
  SharedBotFileView,
} from '../../shared/shared-bots';
import type { SharedBotClient } from './sharedBots';
import { ApiError } from './api';

declare global {
  interface Window {
    openbotFiles?: {
      downloadSharedFile(input: {
        path: string;
        expectedUser: string;
        name: string;
      }): Promise<{ status: 'saved' | 'cancelled' }>;
    };
  }
}

export const SHARED_FILE_LIMIT = 32;
export const SHARED_FILE_BYTES = 10 * 1024 * 1024;
export const SHARED_FILES_BYTES = 50 * 1024 * 1024;
export const sharedFileId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const sharedFileRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function sharedFileSelections(value: unknown): value is SharedBotFileSelection[] {
  return (
    Array.isArray(value) &&
    value.length <= SHARED_FILE_LIMIT &&
    value.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        Object.keys(item).every((key) => key === 'fileId' || key === 'revision') &&
        sharedFileId(item.fileId) &&
        sharedFileRevision(item.revision),
    ) &&
    new Set(value.map((item) => item.fileId)).size === value.length
  );
}
export function validSharedFileGrant(value: unknown): value is SharedBotFileGrant {
  const item = value as SharedBotFileGrant | undefined;
  return (
    !!item &&
    sharedFileId(item.fileId) &&
    sharedFileRevision(item.revision) &&
    typeof item.name === 'string' &&
    item.name.length > 0 &&
    !/[\\/\0]/.test(item.name) &&
    Number.isSafeInteger(item.size) &&
    item.size >= 0 &&
    item.size <= SHARED_FILE_BYTES &&
    typeof item.type === 'string'
  );
}
export function sharedFileProblem(files: SharedBotFileGrant[]): string {
  if (files.length > SHARED_FILE_LIMIT) return uiText('bots:text_56cba96698a4');
  if (
    !files.every(validSharedFileGrant) ||
    new Set(files.map((file) => file.fileId)).size !== files.length
  )
    return uiText('bots:text_5febfd5a93fb');
  return files.reduce((sum, file) => sum + file.size, 0) > SHARED_FILES_BYTES
    ? uiText('bots:text_614a354a00ca')
    : '';
}
export const sharedFileSize = (size: number) =>
  size >= 1048576
    ? `${(size / 1048576).toFixed(1)} MB`
    : size >= 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${size} B`;
export const sharedFileStatus = (file: SharedBotFileView) =>
  file.status === 'available'
    ? uiText('bots:text_27b518df0f71')
    : file.status === 'changed'
      ? uiText('bots:text_954612bc3942')
      : file.status === 'missing'
        ? uiText('bots:text_8f2f8b66c8bc')
        : uiText('bots:text_7ff7ce55fab6');

/** Only explicit clicks download from a fixed, authenticated sharing endpoint. */
export function createSharedFileDownload(options: {
  client: SharedBotClient;
  userId: string;
  basePath: string;
  fetch?: typeof fetch;
  save?: (url: string, name: string) => void;
  allowed?: () => boolean;
  version?: () => string | undefined;
}) {
  const base = options.basePath;
  if (
    !/^\/(?:shared-bots\/[a-f0-9-]{36}|workspaces\/[A-Za-z0-9_-]{1,128}\/agents\/[A-Za-z0-9_-]{1,128}\/sharing)\/files$/.test(
      base,
    )
  )
    throw new Error(uiText('bots:text_c2210390a1d8'));
  let active = true;
  const pending = new Set<AbortController>(),
    urls = new Map<string, ReturnType<typeof setTimeout>>();
  const release = (url: string) => {
    const timer = urls.get(url);
    if (timer) clearTimeout(timer);
    urls.delete(url);
    URL.revokeObjectURL(url);
  };
  return {
    resume() {
      active = true;
    },
    suspend() {
      active = false;
      for (const controller of pending) controller.abort();
      pending.clear();
      for (const url of [...urls.keys()]) release(url);
    },
    async download(file: SharedBotFileGrant) {
      const ticket = options.client.ticket(),
        version = options.version?.();
      if (!active || !options.client.current(ticket) || options.allowed?.() === false) return;
      if (!validSharedFileGrant(file)) throw new Error(uiText('bots:text_9f9cc26a2230'));
      const controller = new AbortController();
      pending.add(controller);
      let url: string | undefined;
      const current = () =>
        active &&
        !controller.signal.aborted &&
        options.client.current(ticket) &&
        options.allowed?.() !== false &&
        options.version?.() === version;
      try {
        const path = `/api${base}/${encodeURIComponent(file.fileId)}/download?revision=${file.revision}`;
        if (typeof window !== 'undefined' && window.openbotFiles?.downloadSharedFile) {
          // Invoke immediately in the click turn; native authorization consumes that gesture.
          const result = await window.openbotFiles.downloadSharedFile({
            path,
            expectedUser: options.userId,
            name: file.name,
          });
          if (!current()) return;
          if (result?.status !== 'saved' && result?.status !== 'cancelled')
            throw new Error(uiText('bots:text_99923848bd92'));
          return;
        }
        const response = await (options.fetch || fetch)(path, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'X-OpenBot-Expected-User': options.userId },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        });
        if (!current()) return;
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          if (!current()) return;
          if (response.status === 401 || response.status === 403)
            window.dispatchEvent(
              new Event(response.status === 403 ? 'openbot:revalidate' : 'openbot:account-expired'),
            );
          throw new ApiError(body.error || uiText('bots:text_f9418acf9ed2'), response.status);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error(uiText('bots:text_5247e090a9b3'));
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (!current()) {
              await reader.cancel();
              return;
            }
            if (part.done) break;
            size += part.value.byteLength;
            if (size > SHARED_FILE_BYTES || size > file.size) {
              await reader.cancel();
              throw new Error(uiText('bots:text_1232cfe60629'));
            }
            chunks.push(new Uint8Array(part.value));
          }
        } finally {
          reader.releaseLock();
        }
        if (size !== file.size) throw new Error(uiText('bots:text_1232cfe60629'));
        if (!current()) return;
        url = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }));
        if (!current()) {
          URL.revokeObjectURL(url);
          url = undefined;
          return;
        }
        const save =
          options.save ||
          ((value: string, name: string) => {
            const anchor = document.createElement('a');
            anchor.href = value;
            anchor.download = name;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
          });
        save(url, file.name);
        const saved = url;
        urls.set(
          saved,
          setTimeout(() => release(saved), 30_000),
        );
        url = undefined;
      } finally {
        controller.abort();
        pending.delete(controller);
        if (url) URL.revokeObjectURL(url);
      }
    },
  };
}
