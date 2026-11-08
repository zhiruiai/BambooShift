import { uiText } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { AvatarAsset, AvatarCrop, AvatarSource } from '../../shared/avatar-assets';
import { AVATAR_UPLOAD_MIME_TYPES, MAX_AVATAR_UPLOAD_BYTES } from '../../shared/avatar-assets';
import { ApiError } from './api';
import { currentWorkspaceId } from './workspace-scope';

export const validAvatarImageId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function avatarImageUrl(id: unknown, workspaceId?: string) {
  return validAvatarImageId(id)
    ? `${workspaceId ? `/api/workspaces/${encodeURIComponent(workspaceId)}` : '/api'}/bot-avatars/${id}`
    : undefined;
}
export type AvatarEditActivity = { pending: boolean; busy: boolean };
export function useAvatarEdits() {
  const entries = useRef<Record<string, AvatarEditActivity>>({});
  const changed = useRef(false);
  useEffect(() => {
    changed.current = false;
  });
  const [, render] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const activity = () => ({
    pending: Object.values(entries.current).some((value) => value.pending),
    busy: Object.values(entries.current).some((value) => value.busy),
    changed: changed.current,
  });
  return {
    ...activity(),
    current: activity,
    resetKey,
    markChanged() {
      changed.current = true;
    },
    reset() {
      entries.current = {};
      changed.current = false;
      setResetKey((value) => value + 1);
    },
    set(key: string, value: AvatarEditActivity) {
      const before = entries.current[key];
      if (before?.pending === value.pending && before?.busy === value.busy) return;
      entries.current[key] = value;
      render((value) => value + 1);
    },
  };
}
export type CropView = { zoom: number; x: number; y: number };
export const initialCropView = (): CropView => ({ zoom: 1, x: 0, y: 0 });
export function constrainCrop(width: number, height: number, value: CropView): CropView {
  const zoom = Math.min(4, Math.max(1, Number.isFinite(value.zoom) ? value.zoom : 1));
  const min = Math.max(1, Math.min(width, height));
  const x = Math.max(0, ((width / min) * zoom - 1) / 2),
    y = Math.max(0, ((height / min) * zoom - 1) / 2);
  return {
    zoom,
    x: Math.min(x, Math.max(-x, Number.isFinite(value.x) ? value.x : 0)),
    y: Math.min(y, Math.max(-y, Number.isFinite(value.y) ? value.y : 0)),
  };
}
export function cropPixels(width: number, height: number, view: CropView): AvatarCrop {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error(uiText('common:text_f88a4d304e05'));
  const bounded = constrainCrop(width, height, view),
    continuousSize = Math.min(width, height) / bounded.zoom,
    size = Math.max(1, Math.floor(continuousSize));
  return {
    size,
    left: Math.min(
      width - size,
      Math.max(0, Math.round((width - continuousSize) / 2 - bounded.x * continuousSize)),
    ),
    top: Math.min(
      height - size,
      Math.max(0, Math.round((height - continuousSize) / 2 - bounded.y * continuousSize)),
    ),
  };
}
type Identity = { workspaceId?: string; userId?: string };
export type AvatarEditorState = {
  phase: 'idle' | 'uploading' | 'editing' | 'saving' | 'error';
  source?: AvatarSource;
  previewUrl?: string;
  error?: string;
};
export function avatarActivity(state: AvatarEditorState): AvatarEditActivity {
  return {
    pending: state.phase !== 'idle',
    busy: state.phase === 'uploading' || state.phase === 'saving',
  };
}
/** Uploads only stage assets. The parent Bot form is the sole publisher. */
export function createAvatarEditor(
  options: Identity & {
    identity: () => Identity;
    enabled: () => boolean;
    onState: (state: AvatarEditorState) => void;
    onAsset: (asset: AvatarAsset) => void;
    fetch?: typeof fetch;
    locationWorkspace?: () => string | undefined;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  },
) {
  const root = options.workspaceId
    ? `/api/workspaces/${encodeURIComponent(options.workspaceId)}`
    : '/api';
  let active = true,
    epoch = 0,
    state: AvatarEditorState = { phase: 'idle' };
  let originalFile: Blob | undefined;
  const controllers = new Set<AbortController>();
  const same = () => {
    const current = options.identity();
    return (
      current.workspaceId === options.workspaceId &&
      current.userId === options.userId &&
      (options.locationWorkspace || currentWorkspaceId)() === options.workspaceId
    );
  };
  const current = (ticket: number) => active && ticket === epoch && same();
  const release = () => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
    if (state.previewUrl) (options.revokeObjectURL || URL.revokeObjectURL)(state.previewUrl);
  };
  function releaseSource(id?: string) {
    if (!id || !validAvatarImageId(id) || !active || !same()) return;
    const controller = new AbortController();
    controllers.add(controller);
    void (options.fetch || fetch)(`${root}/bot-avatars/sources/${id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: options.userId ? { 'X-OpenBot-Expected-User': options.userId } : {},
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    })
      .catch(() => {})
      .finally(() => controllers.delete(controller));
  }
  const publish = (next: AvatarEditorState) => {
    state = next;
    options.onState(next);
  };
  async function request(
    path: string,
    ticket: number,
    body?: Blob | object,
    binary = false,
  ): Promise<any> {
    if (!current(ticket)) throw new DOMException(uiText('common:text_99ce4b004316'), 'AbortError');
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const raw = body instanceof Blob;
      const response = await (options.fetch || fetch)(`${root}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
        headers: {
          ...(options.userId ? { 'X-OpenBot-Expected-User': options.userId } : {}),
          ...(body === undefined
            ? {}
            : { 'Content-Type': raw ? (body as Blob).type : 'application/json' }),
        },
        ...(body === undefined ? {} : { body: raw ? (body as Blob) : JSON.stringify(body) }),
      });
      if (!current(ticket))
        throw new DOMException(uiText('common:text_99ce4b004316'), 'AbortError');
      if (!response.ok) {
        const value = await response.json().catch(() => ({}));
        if (!current(ticket))
          throw new DOMException(uiText('common:text_99ce4b004316'), 'AbortError');
        if (response.status === 401 || response.status === 403) {
          if (typeof window !== 'undefined')
            window.dispatchEvent(
              new Event(
                response.status === 403
                  ? 'openbot:revalidate'
                  : options.workspaceId
                    ? 'openbot:account-expired'
                    : 'openbot:unpaired',
              ),
            );
        }
        throw new ApiError(
          value.error || value.message || uiText('common:text_3dfd2c9f8dde'),
          response.status,
          value.code,
        );
      }
      const value = binary ? await response.blob() : await response.json();
      if (!current(ticket))
        throw new DOMException(uiText('common:text_99ce4b004316'), 'AbortError');
      if (binary && (value.type !== 'image/webp' || value.size > 8 * 1024 * 1024))
        throw new Error(uiText('common:text_90148cc407a7'));
      return value;
    } finally {
      controllers.delete(controller);
    }
  }
  return {
    get state() {
      return state;
    },
    resume() {
      active = true;
    },
    suspend() {
      const sourceId = state.source?.id;
      release();
      releaseSource(sourceId);
      active = false;
      epoch++;
      state = { phase: 'idle' };
      originalFile = undefined;
    },
    cancel() {
      if (!active || !same()) return;
      const sourceId = state.source?.id;
      epoch++;
      release();
      publish({ phase: 'idle' });
      originalFile = undefined;
      releaseSource(sourceId);
    },
    async select(file: Blob) {
      if (!active || !same() || !options.enabled()) return;
      const oldSource = state.source?.id;
      epoch++;
      release();
      const ticket = epoch;
      releaseSource(oldSource);
      if (
        !(AVATAR_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type) ||
        file.size < 1 ||
        file.size >= MAX_AVATAR_UPLOAD_BYTES
      ) {
        publish({
          phase: 'error',
          error: uiText('common:text_e70ee08bae6f'),
        });
        return;
      }
      originalFile = file;
      publish({ phase: 'uploading' });
      try {
        const source: AvatarSource = await request('/bot-avatars/sources', ticket, file);
        if (
          !validAvatarImageId(source.id) ||
          ![source.width, source.height, source.previewWidth, source.previewHeight].every(
            (value) => Number.isSafeInteger(value) && value > 0,
          )
        )
          throw new Error(uiText('common:text_330a56f30d5c'));
        publish({ phase: 'uploading', source });
        const blob: Blob = await request(
          `/bot-avatars/sources/${source.id}`,
          ticket,
          undefined,
          true,
        );
        if (!current(ticket)) return;
        if (!options.enabled()) {
          release();
          publish({ phase: 'idle' });
          originalFile = undefined;
          releaseSource(source.id);
          return;
        }
        const previewUrl = (options.createObjectURL || URL.createObjectURL)(blob);
        if (!current(ticket)) {
          (options.revokeObjectURL || URL.revokeObjectURL)(previewUrl);
          return;
        }
        publish({ phase: 'editing', source, previewUrl });
      } catch (cause) {
        if (current(ticket))
          publish({
            phase: 'error',
            source: state.source,
            error: cause instanceof ApiError ? cause.message : uiText('common:text_b8add5e985d3'),
          });
      }
    },
    async reupload() {
      if (originalFile) await this.select(originalFile);
    },
    async confirm(crop: AvatarCrop) {
      if (!active || !same() || !options.enabled() || state.phase !== 'editing' || !state.source)
        return;
      const ticket = epoch,
        saved = state;
      publish({ ...state, phase: 'saving', error: undefined });
      try {
        const asset: AvatarAsset = await request('/bot-avatars', ticket, {
          sourceId: saved.source!.id,
          crop,
        });
        if (
          !validAvatarImageId(asset.id) ||
          asset.width !== 512 ||
          asset.height !== 512 ||
          asset.mimeType !== 'image/webp'
        )
          throw new Error(uiText('common:text_097d55768848'));
        if (!current(ticket)) return;
        if (!options.enabled()) {
          release();
          publish({ phase: 'idle' });
          originalFile = undefined;
          releaseSource(saved.source!.id);
          return;
        }
        options.onAsset(asset);
        release();
        publish({ phase: 'idle' });
        originalFile = undefined;
        releaseSource(saved.source!.id);
      } catch (cause) {
        if (current(ticket))
          publish({
            ...saved,
            phase: 'editing',
            error: cause instanceof ApiError ? cause.message : uiText('common:text_17bbe6fb310e'),
          });
      }
    },
  };
}
