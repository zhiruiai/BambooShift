import { ApiError } from './api';
import { readBoundedBody } from './filePreview';
import { uiText } from './i18n';

export const PRIVATE_FRAME_CAPABILITY = 'private-takeover-frames-v1';
export const PRIVATE_FRAME_DENIED = 'COMPUTER_PRIVATE_TAKEOVER';
export const PRIVATE_FRAME_UNSUPPORTED = 'COMPUTER_PRIVATE_TAKEOVER_UNSUPPORTED';
export type ScreenFrameAccess = 'shared' | 'takeover';
export type ScreenFrame = { access: ScreenFrameAccess; url: string; capturedAt: string };

export async function readScreenFrame(
  response: Response,
  access: ScreenFrameAccess,
  current: () => boolean,
) {
  const visibility = response.headers.get('X-OpenBot-Frame-Visibility');
  const cache = response.headers
    .get('Cache-Control')
    ?.toLowerCase()
    .split(/\s*,\s*/);
  const expectedVisibility =
    access === 'takeover'
      ? visibility === 'takeover' && cache?.includes('private') && cache.includes('no-store')
      : visibility === null || visibility === 'shared';
  if (!expectedVisibility || response.redirected) {
    await response.body?.cancel().catch(() => {});
    throw new ApiError(uiText('computer:privateTakeoverMasked'), 409, PRIVATE_FRAME_DENIED);
  }
  if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'image/png') {
    await response.body?.cancel().catch(() => {});
    throw new Error(uiText('computer:text_5dc6e1d6046e'));
  }
  const bytes = await readBoundedBody(response, 10 * 1024 * 1024, () => {
    if (!current()) throw new DOMException('Computer frame is stale', 'AbortError');
  });
  if (!bytes.length) throw new Error(uiText('computer:text_5dc6e1d6046e'));
  const captured = response.headers.get('X-Captured-At');
  return {
    blob: new Blob([bytes], { type: 'image/png' }),
    capturedAt:
      captured && !Number.isNaN(Date.parse(captured)) ? captured : new Date().toISOString(),
  };
}

export function createComputerFrameMedia(
  notify: (frame: ScreenFrame | null) => void,
  urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  },
) {
  let frame: ScreenFrame | null = null;
  let image: HTMLImageElement | null = null;
  let pending: AbortController | undefined;
  return {
    bindImage(element: HTMLImageElement | null) {
      image = element;
    },
    begin() {
      if (pending) return;
      pending = new AbortController();
      return pending;
    },
    current(request: AbortController) {
      return pending === request && !request.signal.aborted;
    },
    finish(request: AbortController) {
      if (pending === request) pending = undefined;
    },
    replace(request: AbortController, access: ScreenFrameAccess, blob: Blob, capturedAt: string) {
      if (pending !== request || request.signal.aborted) return;
      const previous = frame;
      frame = { access, url: urls.createObjectURL(blob), capturedAt };
      if (previous) urls.revokeObjectURL(previous.url);
      notify(frame);
    },
    clear(update = true) {
      pending?.abort();
      pending = undefined;
      if (frame) {
        image?.removeAttribute('src');
        urls.revokeObjectURL(frame.url);
        frame = null;
        if (update) notify(null);
      }
    },
  };
}
