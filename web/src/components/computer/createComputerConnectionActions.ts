import { uiText } from '../../i18n';
import { canDecideAction } from '../../../../shared/approvals';
import type { ComputerState } from '../../../../shared/types';
import { remoteShellRequestReadable } from '../RemoteShellDetails';
import type { ComputerConnectionActionsContext } from './createComputerConnectionActions.types';
export function createComputerConnectionActions(read: () => ComputerConnectionActionsContext) {
  async function prepareCloudStart() {
    const { cloudPreparing, observationRequests } = read();

    cloudPreparing.current = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...observationRequests.current.values()]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(uiText('computer:text_3e7eb83e5a05'))),
            12000,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  async function run(work: () => Promise<unknown>, success?: string) {
    const { scope, current, onAction, mounted, loadActions, refresh } = read();

    const version = scope.ticket();
    if (!current(version)) return;
    await onAction(
      scope.guard(work, () => mounted.current),
      success,
    );
    if (!current(version)) return;
    await loadActions();
    if (!current(version)) return;
    await refresh();
  }
  async function decideAction(id: string, approve: boolean) {
    const { scope, panelRef, approvalState, current, deciding, screenshot } = read();

    const version = scope.ticket(),
      requestedPanel = panelRef.current;
    function permitted(dispatch = false) {
      const state = approvalState.current,
        action = state.actions.find((item) => item.id === id);
      if (
        !current(version) ||
        state.panel !== requestedPanel ||
        (!dispatch && state.busy) ||
        state.inputBusy ||
        state.preparing ||
        !action ||
        action.status !== 'pending' ||
        !canDecideAction(action.requester, { userId: state.userId, isOwner: state.owner })
      )
        return;
      const file = action.type === 'upload_file' || action.type === 'download_file';
      if (
        approve &&
        ((!file && (state.controlled || !state.screenReady)) ||
          (action.type === 'remote_shell' && !remoteShellRequestReadable(action.payload)))
      )
        return;
      return action;
    }
    if (deciding.current.has(id) || !permitted()) return;
    deciding.current.add(id);
    try {
      await run(async () => {
        const action = permitted(true);
        if (!action) return;
        await scope.request(
          `/actions/${encodeURIComponent(id)}/${approve ? 'approve' : 'reject'}`,
          'POST',
          undefined,
          requestedPanel === 'files',
        );
        if (
          current(version) &&
          approve &&
          !['upload_file', 'download_file', 'remote_shell'].includes(action.type)
        )
          await screenshot();
      });
    } finally {
      deciding.current.delete(id);
    }
  }
  async function connection(
    work: () => Promise<ComputerState>,
    success: string,
    kind: 'connect' | 'disconnect' | 'reconnect' = 'connect',
  ) {
    const {
      scope,
      current,
      connectionRunning,
      busy,
      inputBusy,
      mounted,
      setConnectionPending,
      setConnectionError,
      setInputBusy,
      leaseRef,
      endTakeover,
      updateLease,
      setTakeover,
      setInputText,
      controlTransition,
      statusSequence,
      clearShot,
      setMachine,
      setToken,
      checkStatus,
      checkComputer,
    } = read();

    const version = scope.ticket();
    if (!current(version) || connectionRunning.current || busy || inputBusy) return;
    const dispatch = scope.guard(work, () => mounted.current);
    connectionRunning.current = true;
    setConnectionPending(kind);
    setConnectionError('');
    setInputBusy(true);
    try {
      if (leaseRef.current) await endTakeover();
      else {
        updateLease(null);
        setTakeover(null);
        setInputText('');
      }
      if (!current(version)) return;
      controlTransition.current = true;
      statusSequence.current++;
      clearShot();
      await run(async () => {
        try {
          const state = await dispatch();
          if (current(version)) {
            setMachine(state);
            if (kind === 'connect' && state.connected) setToken('');
          }
          return state;
        } catch (error) {
          if (current(version)) setConnectionError((error as Error).message);
          throw error;
        }
      }, success);
    } catch (e) {
      if (current(version)) setConnectionError((e as Error).message);
    } finally {
      controlTransition.current = false;
      if (current(version)) await checkStatus();
      if (current(version)) await checkComputer();
      connectionRunning.current = false;
      if (mounted.current) {
        setConnectionPending(null);
        setInputBusy(false);
      }
    }
  }
  return { prepareCloudStart, run, decideAction, connection };
}
