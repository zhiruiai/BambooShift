import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { createChatSendScope } from './chatSendScope';
import { useAppearance } from './useAppearance';
import {
  avatarThemeAppearance,
  avatarThemeSelection,
  parseAvatarThemeSnapshot,
  sameAvatarTheme,
  type AvatarThemePatch,
  type AvatarThemeSnapshot,
  type SyncedAvatarTheme,
} from './avatarThemeSync';

type Identity = { workspaceId: string; userId: string };
type Phase = 'loading' | 'ready' | 'checking' | 'saving' | 'conflict' | 'unknown' | 'unavailable';
type Attempt = { payload: AvatarThemeSnapshot; draft?: SyncedAvatarTheme };
type State = {
  phase: Phase;
  saved?: AvatarThemeSnapshot;
  draft?: SyncedAvatarTheme;
  attempt?: Attempt;
};

export function useWorkspaceAvatarTheme(identity: Identity) {
  const device = useAppearance();
  const latest = useRef({ identity, device });
  latest.current = { identity, device };
  const [scope] = useState(() =>
    createChatSendScope({ ...identity, identity: () => latest.current.identity }),
  );
  const [state, setState] = useState<State>({ phase: 'loading' });
  const current = useRef(state);
  const busy = (value: State) => value.phase === 'checking' || value.phase === 'saving';
  const effective = (value: State) =>
    value.draft ?? value.saved?.theme ?? avatarThemeSelection(latest.current.device);

  function publish(next: State) {
    current.current = next;
    setState(next);
  }

  async function check(initial = false) {
    const ticket = scope.ticket(),
      before = current.current;
    if (!scope.current(ticket) || busy(before) || (!initial && before.phase === 'loading')) return;
    publish({ ...before, phase: initial ? 'loading' : 'checking' });
    try {
      const saved = parseAvatarThemeSnapshot(await scope.request<unknown>('/avatar-theme'));
      if (!scope.current(ticket)) return;
      if (!saved || (before.saved && saved.revision < before.saved.revision)) throw Error();
      const draft = current.current.draft;
      const discard =
        draft &&
        (sameAvatarTheme(draft, saved.theme) ||
          (!saved.theme && !before.saved && !before.attempt) ||
          (!saved.theme &&
            before.attempt?.payload.theme === null &&
            draft === before.attempt.draft));
      publish({ phase: 'ready', saved, draft: discard ? undefined : draft });
    } catch {
      if (scope.current(ticket)) publish({ ...current.current, phase: 'unavailable' });
    }
  }

  useEffect(() => {
    scope.resume();
    void check(true);
    const invalidate = () => {
      scope.suspend();
      publish({ phase: 'unavailable' });
    };
    window.addEventListener('openbot:account-expired', invalidate);
    window.addEventListener('openbot:unpaired', invalidate);
    return () => {
      window.removeEventListener('openbot:account-expired', invalidate);
      window.removeEventListener('openbot:unpaired', invalidate);
      scope.suspend();
    };
  }, [scope]);

  function update(patch: Partial<AvatarThemePatch>) {
    if (!scope.current(scope.ticket())) return;
    const before = current.current;
    const next = avatarThemeSelection({ ...avatarThemeAppearance(effective(before)), ...patch });
    if (!before.saved && !before.attempt) {
      latest.current.device.update(patch);
      if (before.phase === 'loading' || before.draft) publish({ ...before, draft: next });
      return;
    }
    if (before.saved?.theme || before.draft || before.attempt) {
      publish({
        ...before,
        draft: sameAvatarTheme(next, before.saved?.theme ?? null) ? undefined : next,
      });
      return;
    }
    latest.current.device.update(patch);
  }

  function restore() {
    const before = current.current;
    if (scope.current(scope.ticket()) && before.phase === 'ready')
      publish({ ...before, draft: undefined });
  }

  async function write(clear = false) {
    const ticket = scope.ticket(),
      before = current.current;
    if (!scope.current(ticket) || before.phase !== 'ready' || !before.saved) return;
    const theme = clear ? null : effective(before);
    if (sameAvatarTheme(theme, before.saved.theme)) return;
    const payload = { theme, revision: before.saved.revision };
    publish({ ...before, phase: 'saving', attempt: { payload, draft: before.draft } });
    try {
      const saved = parseAvatarThemeSnapshot(
        await scope.request<unknown>('/avatar-theme', 'PUT', payload),
      );
      if (!scope.current(ticket)) return;
      if (!saved || saved.revision !== payload.revision + 1 || !sameAvatarTheme(theme, saved.theme))
        throw Error();
      const draft = current.current.draft;
      publish({
        phase: 'ready',
        saved,
        draft:
          draft === before.draft || (draft && sameAvatarTheme(draft, saved.theme))
            ? undefined
            : draft,
      });
    } catch (cause) {
      if (!scope.current(ticket)) return;
      const phase =
        cause instanceof ApiError && cause.status === 409 && cause.code === 'AVATAR_THEME_CONFLICT'
          ? 'conflict'
          : 'unknown';
      publish({ ...current.current, phase });
    }
  }

  return {
    appearance: avatarThemeAppearance(effective(state)),
    update,
    synced: !!state.saved?.theme,
    preview: !!state.draft,
    phase: state.phase,
    busy: state.phase === 'loading' || busy(state),
    check: () => check(),
    save: () => write(),
    clear: () => write(true),
    restore,
  };
}
