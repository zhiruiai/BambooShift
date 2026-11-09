import { useEffect, useRef } from 'react';
import { uiText } from '../../i18n';
import { ApiError } from '../../api';
import { PRIVATE_FRAME_DENIED, readScreenFrame } from '../../computerFrameMedia';
import type { ComputerState } from '../../../../shared/types';
import { lifecycleCompleted, lifecycleCompletionNotice } from '../../computerLifecycle';
import { screenIdentity } from '../../computerScope';
import type { ComputerObservationContext } from './createComputerObservation.types';
import { type ComputerAction, type Lease, type TakeoverStatus } from './types';
export function createComputerObservation(read: () => ComputerObservationContext) {
  function current(version: number) {
    const { mounted, scope } = read();

    return mounted.current && scope.current(version);
  }
  function applyScreen(state: ComputerState) {
    const {
      agentId,
      computerRef,
      scope,
      observationRequests,
      setInputBusy,
      setPermissionBusy,
      setPreparing,
      lifecycleRecoveryRef,
      lifecyclePendingRef,
      setLifecycleUnknown,
      setLifecycleError,
      setLifecycleConfirmation,
      setLifecycleNotice,
      setComputer,
    } = read();

    if (state.botScreen?.agentId !== agentId) throw new Error(uiText('computer:text_ed0a01801c2b'));
    if (screenIdentity(computerRef.current) !== screenIdentity(state)) {
      scope.invalidate();
      observationRequests.current.clear();
      forgetLease();
      setTakeover(null);
      setInputBusy(false);
      setPermissionBusy(false);
      setPreparing(false);
    }
    const pendingIntent = lifecycleRecoveryRef.current;
    if (
      !lifecyclePendingRef.current &&
      pendingIntent &&
      lifecycleCompleted(pendingIntent, state.botScreen)
    ) {
      lifecycleRecoveryRef.current = null;
      setLifecycleUnknown(false);
      setLifecycleError('');
      setLifecycleConfirmation(null);
      setLifecycleNotice(lifecycleCompletionNotice(pendingIntent, state));
    }
    computerRef.current = state;
    setComputer(state);
  }
  function updateLease(value: Lease | null) {
    const { leaseRef, setLease, privateFramesPaused } = read();
    if (leaseRef.current?.leaseId !== value?.leaseId) {
      privateFramesPaused.current = !value;
      clearShot();
    }
    leaseRef.current = value;
    setLease(value);
  }
  function setTakeover(value: TakeoverStatus | null) {
    const { takeoverRef, leaseRef, setTakeoverState } = read();
    if (value?.active && !leaseRef.current && !takeoverRef.current?.active) clearShot();
    takeoverRef.current = value;
    setTakeoverState(value);
  }
  function usableLease(value = read().leaseRef.current) {
    const { privateFramesPaused, leaseRef } = read();
    return (
      !!value &&
      !privateFramesPaused.current &&
      value.leaseId === leaseRef.current?.leaseId &&
      Date.parse(value.expiresAt) > Date.now()
    );
  }
  function pausePrivateFrames() {
    read().privateFramesPaused.current = true;
    clearShot();
  }
  function expireLease(value: Lease) {
    const { leaseRef, setInputText, setControlError } = read();
    if (value.leaseId !== leaseRef.current?.leaseId) return;
    updateLease(null);
    setInputText('');
    setControlError(uiText('computer:text_cbe197c43f57'));
  }
  function forgetLease() {
    const { leaseRef, scope, setInputText } = read();
    const previous = leaseRef.current;
    setInputText('');
    if (previous) {
      updateLease(null);
      void scope.endLease(previous.leaseId).catch(() => {});
    } else clearShot();
  }
  function clearShot() {
    const {
      media,
      observationRequests,
      setShotError,
      setLoading,
      setZoomed,
      setDragStart,
      setPointerMode,
    } = read();

    media.clear();
    observationRequests.current.delete('screenshot');
    setShotError('');
    setLoading(false);
    setZoomed(false);
    setDragStart(null);
    setPointerMode('click');
  }
  function observe(key: string, work: () => Promise<void>): Promise<void> {
    const { observationRequests, cloudPreparing, lifecyclePendingRef, mounted } = read();

    const active = observationRequests.current.get(key);
    if (active) return active;
    if (cloudPreparing.current || lifecyclePendingRef.current || !mounted.current)
      return Promise.resolve();
    const pending = work().finally(() => {
      if (observationRequests.current.get(key) === pending) observationRequests.current.delete(key);
    });
    observationRequests.current.set(key, pending);
    return pending;
  }
  function loadActions() {
    const { panelRef, agentId, computerRef, scope, setActions, setControlError } = read();

    const requestedPanel = panelRef.current;
    const screen = computerRef.current.botScreen;
    if (requestedPanel !== 'files' && (!agentId || (!screen?.screenId && !screen?.shared)))
      return Promise.resolve();
    return observe(`actions:${requestedPanel}`, async () => {
      const version = scope.ticket();
      try {
        const a = await scope.request<ComputerAction[]>(
          '/actions',
          'GET',
          undefined,
          requestedPanel === 'files',
        );
        if (current(version) && requestedPanel === panelRef.current) setActions(a);
      } catch (e) {
        if (current(version)) setControlError((e as Error).message);
      }
    });
  }
  function checkStatus() {
    const {
      agentId,
      controlTransition,
      computerRef,
      scope,
      statusSequence,
      leaseRef,
      setDragStart,
      setControlError,
    } = read();

    if (!agentId || controlTransition.current || computerRef.current.botScreen?.status !== 'ready')
      return Promise.resolve();
    return observe('takeover', async () => {
      const version = scope.ticket(),
        sequence = ++statusSequence.current;
      try {
        const status = await scope.request<TakeoverStatus>('/takeover/status');
        if (!current(version) || sequence !== statusSequence.current || controlTransition.current)
          return;
        setTakeover(status);
        if (
          leaseRef.current &&
          (!status.active ||
            (status.expiresAt &&
              Date.parse(status.expiresAt) !== Date.parse(leaseRef.current.expiresAt)))
        ) {
          expireLease(leaseRef.current);
          return;
        }
        if (
          status.active &&
          leaseRef.current &&
          (leaseRef.current.width !== status.width || leaseRef.current.height !== status.height)
        ) {
          updateLease({
            ...leaseRef.current,
            width: status.width,
            height: status.height,
            surface: status.surface,
          });
          setDragStart(null);
        }
      } catch (e) {
        if (current(version)) setControlError((e as Error).message);
      }
    });
  }
  function screenshot() {
    const {
      computerRef,
      scope,
      media,
      takeoverRef,
      panelRef,
      controlTransition,
      setLoading,
      leaseRef,
      setDragStart,
      setShotError,
    } = read();

    return observe('screenshot', async () => {
      if (computerRef.current.botScreen?.status !== 'ready') return;
      const lease = leaseRef.current;
      const version = scope.ticket();
      const allowed = () =>
        current(version) &&
        panelRef.current === 'screen' &&
        (typeof document === 'undefined' || !document.hidden) &&
        (lease
          ? usableLease(lease)
          : !leaseRef.current && !takeoverRef.current?.active && !controlTransition.current);
      if (!allowed()) return;
      const request = media.begin();
      if (!request) return;
      const exact = () => media.current(request) && allowed();
      const access = lease ? 'takeover' : 'shared';
      setLoading(true);
      try {
        const r = lease
          ? await scope.privateScreenshot(lease.leaseId, request.signal)
          : await scope.response('/screenshot', { signal: request.signal, redirect: 'error' });
        const { blob, capturedAt } = await readScreenFrame(r, access, exact);
        if (!exact()) return;
        media.replace(request, access, blob, capturedAt);
        const frameWidth = Number(r.headers.get('X-Frame-Width')),
          frameHeight = Number(r.headers.get('X-Frame-Height'));
        if (
          lease &&
          frameWidth > 0 &&
          frameHeight > 0 &&
          leaseRef.current &&
          (leaseRef.current.width !== frameWidth || leaseRef.current.height !== frameHeight)
        ) {
          updateLease({ ...leaseRef.current, width: frameWidth, height: frameHeight });
          setDragStart(null);
        }
        setShotError('');
      } catch (e) {
        if (!exact()) return;
        const masked = e instanceof ApiError && e.code === PRIVATE_FRAME_DENIED;
        if (lease && masked) pausePrivateFrames();
        else if (lease || masked) clearShot();
        setShotError(masked ? uiText('computer:privateTakeoverMasked') : (e as Error).message);
      } finally {
        if (media.current(request) && current(version)) setLoading(false);
        media.finish(request);
      }
    });
  }
  return {
    current,
    applyScreen,
    updateLease,
    setTakeover,
    usableLease,
    expireLease,
    forgetLease,
    pausePrivateFrames,
    clearShot,
    observe,
    loadActions,
    checkStatus,
    screenshot,
  };
}

export function useComputerFramePolling(
  visible: boolean,
  screenIdentity: string,
  leaseId: string | undefined,
  otherControlled: boolean,
  autoRefresh: boolean,
  task: ComputerState['botScreen'] | undefined,
  actions: ComputerAction[],
  capture: () => Promise<void>,
) {
  const latest = useRef(capture);
  latest.current = capture;
  const observingWork =
    visible &&
    !leaseId &&
    !otherControlled &&
    (task?.task?.status === 'running' || actions.some((action) => action.status === 'running'));
  const following = visible && autoRefresh && (!!leaseId || observingWork);
  useEffect(() => {
    if (visible && (typeof document === 'undefined' || !document.hidden)) void latest.current();
  }, [visible, screenIdentity, leaseId, otherControlled]);
  useEffect(() => {
    if (!following) return;
    const refresh = () => {
      if (typeof document === 'undefined' || !document.hidden) void latest.current();
    };
    refresh();
    const timer = setInterval(refresh, leaseId ? 2000 : 3500);
    return () => clearInterval(timer);
  }, [following, leaseId]);
  return observingWork;
}
