import { uiText } from '../i18n';
import { type SidebarRosterOperation } from '../../../shared/sidebar-roster';
import { ApiError } from '../api';
import { canStopConversation } from '../approvalUi';
import { type FormSaveResult } from '../formSubmission';
import type { WorkspaceActionsContext } from './createWorkspaceActions.types';
export function createWorkspaceActions(read: () => WorkspaceActionsContext) {
  async function formAction(
    work: () => Promise<unknown>,
    success?: string,
  ): Promise<FormSaveResult> {
    const { setBusy, sync, setToast, sendScope } = read();
    const ticket = sendScope.ticket();
    if (!sendScope.current(ticket))
      return { ok: false, error: uiText('workspace:text_75d366e971e2') };

    setBusy(true);
    try {
      await work();
      if (!sendScope.current(ticket))
        return { ok: false, error: uiText('workspace:text_75d366e971e2') };
      sync.written();
      await refresh();
      if (success && sendScope.current(ticket)) setToast(success);
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : uiText('workspace:text_072387ead00b'),
      };
    } finally {
      if (sendScope.current(ticket)) setBusy(false);
    }
  }
  async function action(work: () => Promise<unknown>, success?: string) {
    const { setToast, sendScope } = read();
    const ticket = sendScope.ticket();

    const result = await formAction(work, success);
    if (!result.ok && sendScope.current(ticket)) setToast(result.error);
  }
  async function stopCurrentTask() {
    const {
      sendScope,
      selected,
      stopState,
      stopping,
      setBusy,
      sync,
      setToast,
      composerKey,
      threadRootId,
    } = read();

    const version = sendScope.ticket(),
      target = selected;
    const allowed = () => {
      const current = stopState.current;
      return (
        sendScope.current(version) &&
        current.selected === target &&
        current.threadRootId === threadRootId &&
        current.working &&
        canStopConversation(current.requests, target, {
          userId: current.userId,
          isOwner: current.owner,
        })
      );
    };
    if (stopping.current || stopState.current.busy || !allowed()) return;
    stopping.current = true;
    setBusy(true);
    try {
      const scope = threadRootId
        ? `?threadRootId=${encodeURIComponent(threadRootId)}`
        : composerKey !== undefined
          ? '?scope=main'
          : '';
      await sendScope.request(`/conversations/${encodeURIComponent(target)}/stop${scope}`, 'POST');
      if (!sendScope.current(version)) return;
      sync.written();
      await refresh();
    } catch (cause) {
      if (sendScope.current(version))
        setToast(
          cause instanceof ApiError && cause.status === 0
            ? uiText('workspace:text_fdc61c8e2914')
            : cause instanceof Error
              ? cause.message
              : uiText('workspace:text_b7bf9d5b22ca'),
        );
    } finally {
      stopping.current = false;
      if (sendScope.current(version)) setBusy(false);
    }
  }
  async function changeRoster(operation: SidebarRosterOperation, notice: string) {
    const { sendScope, setMenuOpen, roster, setToast } = read();

    if (!sendScope.current(sendScope.ticket())) return;
    setMenuOpen(false);
    const result = await roster.write(operation);
    if (!sendScope.current(sendScope.ticket())) return;
    setToast(result.ok ? notice : result.message);
  }
  function refresh() {
    const { sync } = read();

    return sync.refresh();
  }
  return { formAction, action, stopCurrentTask, changeRoster, refresh };
}
