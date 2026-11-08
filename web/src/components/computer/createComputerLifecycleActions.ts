import { uiText } from '../../i18n';
import type { ComputerState } from '../../../../shared/types';
import {
  lifecycleCompleted,
  lifecycleCompletionNotice,
  lifecycleIntent,
  lifecycleNotStarted,
  lifecycleRequest,
  type ComputerLifecycleIntent,
} from '../../computerLifecycle';
import { type BotScreenInventory } from '../../computerScope';
import type { ComputerLifecycleActionsContext } from './createComputerLifecycleActions.types';
export function createComputerLifecycleActions(read: () => ComputerLifecycleActionsContext) {
  function checkComputer() {
    const {
      observe,
      scope,
      setPermissionBusy,
      agentId,
      current,
      setInventory,
      applyScreen,
      setControlError,
    } = read();

    return observe('computer', async () => {
      const version = scope.ticket();
      setPermissionBusy(true);
      try {
        const [inventory, state] = await Promise.all([
          scope.request<BotScreenInventory>('/bots', 'GET', undefined, true),
          agentId ? scope.request<ComputerState>('/status') : undefined,
        ]);
        if (!current(version)) return;
        setInventory(inventory);
        if (state) applyScreen(state);
      } catch (error) {
        if (current(version)) setControlError((error as Error).message);
      } finally {
        if (current(version)) setPermissionBusy(false);
      }
    });
  }
  function chooseLifecycle(kind: ComputerLifecycleIntent['kind']) {
    const {
      canManage,
      busy,
      inputBusy,
      preparing,
      lifecycleLocalBlock,
      lifecycleUnknown,
      setLifecycleConfirmation,
      computerRef,
      setLifecycleUnknown,
      setLifecycleError,
      setLifecycleNotice,
    } = read();

    if (!canManage || busy || inputBusy || preparing || lifecycleLocalBlock) return;
    if (lifecycleUnknown && kind !== 'resume') return;
    try {
      setLifecycleConfirmation(lifecycleIntent(computerRef.current.botScreen, kind));
      if (kind === 'resume') setLifecycleUnknown(false);
      setLifecycleError('');
      setLifecycleNotice('');
    } catch (error) {
      setLifecycleError((error as Error).message);
    }
  }
  async function submitLifecycle() {
    const {
      lifecycleConfirmationRef,
      canManage,
      busy,
      inputBusy,
      preparing,
      lifecyclePendingRef,
      lifecycleUnknownRef,
      lifecycleLocalBlock,
      computerRef,
      setLifecycleError,
      scope,
      observationRequests,
      clearShot,
      lifecycleRecoveryRef,
      controlTransition,
      setLifecyclePending,
      setInputBusy,
      setLifecycleNotice,
      current,
      applyScreen,
      setLifecycleUnknown,
      setActions,
      setLifecycleConfirmation,
      refresh,
      mounted,
    } = read();

    const intent = lifecycleConfirmationRef.current;
    if (
      !intent ||
      !canManage ||
      busy ||
      inputBusy ||
      preparing ||
      lifecyclePendingRef.current ||
      (lifecycleUnknownRef.current && intent.kind !== 'resume') ||
      lifecycleLocalBlock
    )
      return;
    let request: ReturnType<typeof lifecycleRequest>;
    try {
      request = lifecycleRequest(intent, computerRef.current.botScreen);
    } catch (error) {
      setLifecycleError((error as Error).message);
      return;
    }
    scope.invalidate();
    observationRequests.current.clear();
    clearShot();
    const version = scope.ticket();
    lifecyclePendingRef.current = true;
    lifecycleRecoveryRef.current = intent;
    controlTransition.current = true;
    setLifecyclePending(true);
    setInputBusy(true);
    setLifecycleError('');
    setLifecycleNotice('');
    try {
      const state = await scope.request<ComputerState>(request.path, 'POST', request.body);
      if (!current(version)) return;
      if (!lifecycleCompleted(intent, state.botScreen)) {
        applyScreen(state);
        setLifecycleUnknown(true);
        setLifecycleError(uiText('computer:text_8145ef125905'));
        return;
      }
      applyScreen(state);
      setActions([]);
      setLifecycleConfirmation(null);
      lifecycleRecoveryRef.current = null;
      setLifecycleUnknown(false);
      setLifecycleNotice(lifecycleCompletionNotice(intent, state));
      await refresh();
    } catch (error) {
      if (current(version)) {
        const notStarted = lifecycleNotStarted(error);
        setLifecycleUnknown(!notStarted);
        if (notStarted) lifecycleRecoveryRef.current = null;
        setLifecycleError((error as Error).message);
      }
    } finally {
      lifecyclePendingRef.current = false;
      controlTransition.current = false;
      if (mounted.current) {
        setLifecyclePending(false);
        setInputBusy(false);
        void checkComputer();
      }
    }
  }
  async function prepareScreen() {
    const {
      agent,
      canManage,
      busy,
      lifecycleUnknown,
      preparing,
      inputBusy,
      scope,
      setPreparing,
      setControlError,
      current,
      applyScreen,
      mounted,
    } = read();

    if (!agent || !canManage || busy || lifecycleUnknown || preparing || inputBusy) return;
    const version = scope.ticket();
    setPreparing(true);
    setControlError('');
    try {
      const state = await scope.request<ComputerState>('/prepare', 'POST');
      if (current(version)) {
        applyScreen(state);
        await checkComputer();
      }
    } catch (error) {
      if (current(version)) setControlError((error as Error).message);
    } finally {
      if (mounted.current) setPreparing(false);
    }
  }
  async function selectSurface(surface: 'browser' | 'desktop') {
    const {
      screenReady,
      inputBusy,
      scope,
      setInputBusy,
      setControlError,
      endTakeover,
      current,
      controlTransition,
      statusSequence,
      applyScreen,
      refresh,
      mounted,
      checkStatus,
    } = read();

    if (!screenReady || inputBusy) return;
    const version = scope.ticket();
    setInputBusy(true);
    setControlError('');
    try {
      await endTakeover();
      if (!current(version)) return;
      controlTransition.current = true;
      statusSequence.current++;
      const state = await scope.request<ComputerState>('/surface', 'POST', {
        surface,
        confirm: true,
      });
      if (current(version)) {
        applyScreen(state);
        await refresh();
      }
    } catch (error) {
      if (current(version)) setControlError((error as Error).message);
    } finally {
      controlTransition.current = false;
      if (mounted.current) {
        setInputBusy(false);
        void checkStatus();
      }
    }
  }
  return { checkComputer, chooseLifecycle, submitLifecycle, prepareScreen, selectSurface };
}
