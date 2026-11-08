import { uiText } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { SidebarRosterOperation, SidebarRosterState } from '../../shared/sidebar-roster';
import { ApiError } from './api';
import { createPrimaryBotScope } from './primaryBot';

export type RosterWriteResult =
  { ok: true; state: SidebarRosterState } | { ok: false; review: boolean; message: string };
export interface SidebarRosterController {
  state?: SidebarRosterState;
  busy: boolean;
  needsSync: boolean;
  error: string;
  write: (
    operation: SidebarRosterOperation,
    expectedRevision?: string,
  ) => Promise<RosterWriteResult>;
  read: () => Promise<SidebarRosterState | undefined>;
}
export function useSidebarRoster(options: {
  workspaceId?: string;
  userId?: string;
  state?: SidebarRosterState;
  onChanged: (
    state: SidebarRosterState,
    expectedRevision: string | undefined,
    written: boolean,
  ) => void;
}): SidebarRosterController {
  const latest = useRef(options);
  latest.current = options;
  const [scope] = useState(() =>
    createPrimaryBotScope({ ...options, identity: () => latest.current }),
  );
  const running = useRef(false);
  const syncRequired = useRef(false);
  const [busy, setBusy] = useState(false),
    [needsSync, setNeedsSync] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    scope.resume();
    return () => scope.suspend();
  }, [scope]);
  async function write(
    operation: SidebarRosterOperation,
    expectedRevision = latest.current.state?.revision,
  ): Promise<RosterWriteResult> {
    const ticket = scope.ticket();
    if (!scope.current(ticket) || running.current || !latest.current.state || !expectedRevision)
      return { ok: false, review: false, message: uiText('common:text_49d77899441d') };
    if (syncRequired.current)
      return { ok: false, review: true, message: uiText('common:text_dc588598af1b') };
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const state = await scope.request<SidebarRosterState>('/sidebar-roster', 'PUT', {
        expectedRevision,
        operation,
      });
      if (!scope.current(ticket))
        return { ok: false, review: false, message: uiText('common:text_75d366e971e2') };
      latest.current.onChanged(state, expectedRevision, true);
      syncRequired.current = false;
      setNeedsSync(false);
      return { ok: true, state };
    } catch (cause) {
      if (!scope.current(ticket))
        return { ok: false, review: false, message: uiText('common:text_75d366e971e2') };
      const review =
        !(cause instanceof ApiError) ||
        cause.status === 0 ||
        cause.status === 408 ||
        cause.status === 409 ||
        cause.status >= 500;
      const message = review
        ? uiText('common:text_22d78e5b18a5', {
            value0:
              cause instanceof ApiError && cause.status === 409
                ? uiText('common:text_e7d202b60c99')
                : uiText('common:text_764efb5ede1e'),
          })
        : (cause as Error).message;
      setError(message);
      syncRequired.current = review;
      setNeedsSync(review);
      return { ok: false, review, message };
    } finally {
      running.current = false;
      if (scope.current(ticket)) setBusy(false);
    }
  }
  async function read() {
    const ticket = scope.ticket(),
      before = latest.current.state?.revision;
    if (!scope.current(ticket) || running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const state = await scope.request<SidebarRosterState>('/sidebar-roster');
      if (!scope.current(ticket)) return;
      // A bootstrap accepted while this GET was in flight is newer than our
      // starting snapshot. Do not replace it, or offer an older revision to a form.
      const observed = latest.current.state?.revision !== before ? latest.current.state : state;
      if (!observed) return;
      if (observed === state) latest.current.onChanged(state, before, false);
      syncRequired.current = false;
      setNeedsSync(false);
      return observed;
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) setBusy(false);
    }
  }
  return { state: options.state, busy, needsSync, error, write, read };
}
