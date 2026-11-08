import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { BrowserContext, Page, Download, JSHandle } from 'playwright-core';
import { MAX_FILE_TRANSFER_BYTES } from '../../../shared/computer-files.js';
import {
  validateComputerPath,
  resolveWorkspacePath,
  writeComputerFile,
} from '../computer-runtime/computer-files.js';
import { resolveBrowserTarget } from './network.js';
import type { ComputerActionInput } from './protocol.js';
interface DownloadContext {
  workspace: string;
  browser(): Promise<Page>;
  context(): BrowserContext | undefined;
  assertAgentAccess(): void;
}
export async function captureDownload(
  context: DownloadContext,
  action: ComputerActionInput,
  signal: AbortSignal,
) {
  const check = () => {
    if (signal.aborted)
      throw signal.reason instanceof Error && signal.reason.name === 'Error'
        ? signal.reason
        : new Error('网页导出已取消。');
    context.assertAgentAccess();
  };
  check();
  const path = validateComputerPath(action.path);
  const destination = await resolveWorkspacePath(context.workspace, path, true);
  if (
    await lstat(destination).catch((error: any) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    })
  )
    throw Object.assign(new Error('目标位置已有同名文件，请换一个文件名。'), { code: 'EEXIST' });
  const page = await context.browser();
  check();
  const session = await context.context()!.newCDPSession(page);
  let claimed = false,
    finished = false;
  let blobReading = false;
  let anchorDownload: string | undefined;
  let requestId: string | undefined, stream: string | undefined;
  let blobReader: JSHandle<any> | undefined;
  const handlers = new Set<Promise<unknown>>();
  let receive!: (bytes: Buffer) => void, fail!: (error: unknown) => void;
  const body = new Promise<Buffer>((resolveBody, rejectBody) => {
    receive = resolveBody;
    fail = rejectBody;
  });
  // Attach the rejection handler before enabling interception or starting a click.
  const completed = waitWithCancellation(body, signal).catch((error) => {
    check();
    throw error;
  });
  void completed.catch(() => {});
  const track = (operation: Promise<unknown>) => {
    handlers.add(operation);
    void operation.catch(fail).finally(() => handlers.delete(operation));
  };
  const readHttp = async (event: {
    requestId: string;
    request: { url: string };
    responseStatusCode?: number;
    responseHeaders?: Array<{ name: string; value: string }>;
  }) => {
    if (finished) return;
    const header = (name: string) =>
      event.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
    if (
      !/^\s*attachment(?:;|$)/i.test(header('content-disposition') ?? '') &&
      event.request.url !== anchorDownload
    ) {
      await session.send('Fetch.continueRequest', { requestId: event.requestId });
      return;
    }
    if (claimed) {
      await session.send('Fetch.failRequest', {
        requestId: event.requestId,
        errorReason: 'Aborted',
      });
      return;
    }
    claimed = true;
    requestId = event.requestId;
    check();
    await resolveBrowserTarget(new URL(event.request.url));
    if (
      !event.responseStatusCode ||
      event.responseStatusCode < 200 ||
      event.responseStatusCode >= 300
    )
      throw new Error('网页导出没有返回成功的文件响应。');
    if (Number(header('content-length')) > MAX_FILE_TRANSFER_BYTES)
      throw new Error('文件不能超过 10 MiB。');
    stream = (await session.send('Fetch.takeResponseBodyAsStream', { requestId })).stream;
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      check();
      const part = await session.send('IO.read', {
        handle: stream,
        size: Math.min(64 * 1024, MAX_FILE_TRANSFER_BYTES + 1 - size),
      });
      check();
      const bytes = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8');
      size += bytes.length;
      if (size > MAX_FILE_TRANSFER_BYTES) throw new Error('文件不能超过 10 MiB。');
      chunks.push(bytes);
      if (part.eof) break;
    }
    receive(Buffer.concat(chunks, size));
  };
  // This fixed internal reader accepts only the URL emitted by Chromium's download event.
  // It cannot fetch HTTP URLs or expose arbitrary JavaScript to a model.
  const readBlob = async (download: Download) => {
    if (finished || claimed) return;
    claimed = true;
    await download.cancel();
    check();
    const url = download.url();
    const parsed = new URL(url);
    if (!['blob:', 'data:'].includes(parsed.protocol))
      throw new Error('该网页未提供可识别的文件响应；请使用网站的附件导出按钮。');
    if (url.length > MAX_FILE_TRANSFER_BYTES * 3 + 1024) throw new Error('文件不能超过 10 MiB。');
    if (parsed.protocol === 'blob:' && parsed.origin !== new URL(page.url()).origin)
      throw new Error('只允许下载当前网页生成的文件。');
    blobReading = true;
    const handle = await page.evaluateHandle(
      async ({ source, maximum }) => {
        const response = await fetch(source);
        if (!response.ok || !response.body) throw new Error('网页生成的文件已失效，请重新导出。');
        if (Number(response.headers.get('content-length')) > maximum) {
          await response.body.cancel();
          throw new Error('文件不能超过 10 MiB。');
        }
        return {
          reader: response.body.getReader(),
          pending: null as Uint8Array | null,
          offset: 0,
        };
      },
      { source: url, maximum: MAX_FILE_TRANSFER_BYTES },
    );
    blobReader = handle;
    if (finished || signal.aborted) {
      await handle.evaluate((state) => state.reader.cancel()).catch(() => {});
      await handle.dispose().catch(() => {});
      return;
    }
    check();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      check();
      const part = await handle.evaluate(async (state, remaining) => {
        if (!state.pending) {
          const next = await state.reader.read();
          if (next.done) return { done: true, bytes: [], over: false };
          if (next.value.byteLength > remaining) {
            await state.reader.cancel();
            return { done: false, bytes: [], over: true };
          }
          state.pending = next.value;
          state.offset = 0;
        }
        const end = Math.min(state.offset + 64 * 1024, state.pending.byteLength);
        const bytes = Array.from(state.pending.subarray(state.offset, end));
        state.offset = end;
        if (end === state.pending.byteLength) state.pending = null;
        return { done: false, bytes, over: false };
      }, MAX_FILE_TRANSFER_BYTES - size);
      check();
      if (part.over) throw new Error('文件不能超过 10 MiB。');
      if (part.done) break;
      const bytes = Buffer.from(part.bytes);
      size += bytes.length;
      chunks.push(bytes);
    }
    receive(Buffer.concat(chunks, size));
  };
  const onPaused = (event: Parameters<typeof readHttp>[0]) => track(readHttp(event));
  const onDownload = (download: Download) => track(readBlob(download));
  const onClosed = () => fail(new Error('导出页面已关闭。'));
  session.on('Fetch.requestPaused', onPaused);
  page.on('download', onDownload);
  page.on('close', onClosed);
  let clickFinished = false;
  try {
    check();
    const explicitHref = await waitWithCancellation(
      page
        .locator(action.selector!)
        .first()
        .evaluate(
          (element) =>
            element instanceof HTMLAnchorElement && element.hasAttribute('download')
              ? element.href
              : null,
          undefined,
          { timeout: 10_000 },
        ),
      signal,
    );
    if (explicitHref) {
      const url = new URL(explicitHref);
      if (['http:', 'https:'].includes(url.protocol)) {
        url.hash = '';
        await resolveBrowserTarget(url);
        anchorDownload = url.href;
      }
    }
    check();
    await session.send('Fetch.enable', {
      patterns: [
        { urlPattern: 'http://*', resourceType: 'Document', requestStage: 'Response' },
        { urlPattern: 'https://*', resourceType: 'Document', requestStage: 'Response' },
      ],
    });
    check();
    // Never wait for navigation before consuming the intercepted response.
    track(
      page
        .locator(action.selector!)
        .first()
        .click({ timeout: 10_000, noWaitAfter: true })
        .finally(() => {
          clickFinished = true;
        }),
    );
    const bytes = await completed;
    check();
    await writeComputerFile(context.workspace, path, bytes, signal);
    return { path, name: basename(path), size: bytes.length };
  } finally {
    finished = true;
    // Closing this managed page also interrupts a site's stalled/overridden blob reader.
    // A still-waiting locator must never click after cancellation or approval expiry.
    if (!clickFinished || (signal.aborted && blobReading))
      await page.close({ runBeforeUnload: false }).catch(() => {});
    // IO.close discards Chromium's temporary stream storage; cancel before disabling Fetch.
    if (stream) await session.send('IO.close', { handle: stream }).catch(() => {});
    if (requestId)
      await session
        .send('Fetch.failRequest', { requestId, errorReason: 'Aborted' })
        .catch(() => {});
    if (blobReader) {
      await blobReader.evaluate((state) => state.reader.cancel()).catch(() => {});
      await blobReader.dispose().catch(() => {});
    }
    session.off('Fetch.requestPaused', onPaused);
    page.off('download', onDownload);
    page.off('close', onClosed);
    await session.send('Fetch.disable').catch(() => {});
    await session.detach().catch(() => {});
    await Promise.allSettled(handlers);
  }
}

function waitWithCancellation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolveWait, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('任务已取消。'));
    };
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(new Error('任务已取消。'));
        else resolveWait(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** An independent computer connection, approval queue and browser per workspace. */
