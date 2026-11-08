import { type MouseEvent } from 'react';
import { ApiError } from '../../api';
import { PRIVATE_FRAME_UNSUPPORTED } from '../../computerFrameMedia';
import { uiText } from '../../i18n';
import type { ComputerInputContext } from './createComputerInput.types';
import { type Lease } from './types';
export function createComputerInput(read: () => ComputerInputContext) {
  async function startTakeover() {
    const {
      screenReady,
      takeoverSupported,
      inputBusy,
      scope,
      controlTransition,
      statusSequence,
      setInputBusy,
      setControlError,
      current,
      updateLease,
      setTakeover,
      setClock,
      setAutoRefresh,
      clearShot,
      screenshot,
    } = read();

    if (!screenReady || !takeoverSupported || inputBusy || controlTransition.current) return;
    const version = scope.ticket();
    controlTransition.current = true;
    statusSequence.current++;
    clearShot();
    setInputBusy(true);
    setControlError('');
    try {
      const value = await scope.startLease<Lease>();
      if (!current(version)) {
        await scope.endLease(value.leaseId);
        return;
      }
      updateLease(value);
      setTakeover({
        active: true,
        expiresAt: value.expiresAt,
        width: value.width,
        height: value.height,
        surface: value.surface,
      });
      setClock(Date.now());
      setAutoRefresh(true);
      await screenshot();
    } catch (e) {
      if (current(version))
        setControlError(
          e instanceof ApiError && e.code === PRIVATE_FRAME_UNSUPPORTED
            ? uiText('computer:privateTakeoverUnsupported')
            : (e as Error).message,
        );
    } finally {
      controlTransition.current = false;
      if (current(version)) setInputBusy(false);
    }
  }
  async function endTakeover() {
    const {
      leaseRef,
      controlTransition,
      statusSequence,
      scope,
      current,
      pausePrivateFrames,
      updateLease,
      setTakeover,
      setInputText,
      setDragStart,
      setControlError,
    } = read();

    const value = leaseRef.current;
    if (!value) return;
    const version = scope.ticket();
    controlTransition.current = true;
    statusSequence.current++;
    pausePrivateFrames();
    setInputText('');
    try {
      await scope.endLease(value.leaseId);
    } finally {
      controlTransition.current = false;
    }
    if (!current(version) || leaseRef.current?.leaseId !== value.leaseId) return;
    updateLease(null);
    setTakeover({
      active: false,
      width: value.width,
      height: value.height,
      surface: value.surface,
    });
    setDragStart(null);
    setControlError('');
  }
  async function finish(close = false, nextBot?: string) {
    const {
      busy,
      inputBusy,
      preparing,
      connectionRunning,
      scope,
      observationRequests,
      clearShot,
      setInputBusy,
      current,
      onSelectBot,
      onClose,
      setControlError,
      checkStatus,
    } = read();

    if (busy || inputBusy || preparing || connectionRunning.current) return;
    scope.invalidate();
    observationRequests.current.clear();
    clearShot();
    const version = scope.ticket();
    setInputBusy(true);
    try {
      await endTakeover();
      if (!current(version)) return;
      if (close || nextBot) {
        scope.invalidate();
        clearShot();
      }
      if (nextBot) onSelectBot(nextBot);
      else if (close) onClose();
    } catch (e) {
      if (current(version)) {
        setControlError((e as Error).message);
        await checkStatus();
      }
    } finally {
      if (current(version)) setInputBusy(false);
    }
  }
  async function manual(payload: Record<string, unknown>) {
    const {
      leaseRef,
      scope,
      inputBusy,
      teachingBlocked,
      setInputBusy,
      setControlError,
      current,
      setInputText,
      screenshot,
      checkStatus,
      usableLease,
    } = read();

    const value = leaseRef.current,
      version = scope.ticket();
    if (!value || !usableLease(value) || inputBusy || teachingBlocked) return;
    setInputBusy(true);
    setControlError('');
    try {
      await scope.request('/takeover/input', 'POST', { leaseId: value.leaseId, ...payload });
      if (!current(version)) return;
      if (payload.type === 'type') setInputText('');
      await screenshot();
    } catch (e) {
      if (current(version)) {
        setControlError((e as Error).message);
        await checkStatus();
      }
    } finally {
      if (current(version)) setInputBusy(false);
    }
  }
  function clickScreen(event: MouseEvent<HTMLImageElement>) {
    const {
      leaseRef,
      usableLease,
      inputBusy,
      teachingBlocked,
      shotError,
      shotAt,
      loading,
      isDesktop,
      pointerMode,
      dragStart,
      setDragStart,
    } = read();

    const current = leaseRef.current;
    if (
      !current ||
      !usableLease(current) ||
      inputBusy ||
      teachingBlocked ||
      shotError ||
      !shotAt ||
      loading
    )
      return;
    const element = event.currentTarget,
      rect = element.getBoundingClientRect();
    const imageRatio =
      (element.naturalWidth || current.width) / (element.naturalHeight || current.height);
    const actualWidth = Math.min(rect.width, rect.height * imageRatio),
      actualHeight = actualWidth / imageRatio;
    const px = event.clientX - rect.left - (rect.width - actualWidth) / 2,
      py = event.clientY - rect.top - (rect.height - actualHeight) / 2;
    if (px < 0 || py < 0 || px > actualWidth || py > actualHeight) return;
    const point = {
      x: Math.min(current.width - 1, Math.max(0, Math.round((px / actualWidth) * current.width))),
      y: Math.min(
        current.height - 1,
        Math.max(0, Math.round((py / actualHeight) * current.height)),
      ),
    };
    if (isDesktop && pointerMode === 'drag') {
      if (!dragStart) {
        setDragStart(point);
        return;
      }
      const from = dragStart;
      setDragStart(null);
      void manual({
        type: 'drag',
        x: from.x,
        y: from.y,
        toX: point.x,
        toY: point.y,
        durationMs: 600,
      });
      return;
    }
    void manual({
      type: 'click',
      ...point,
      ...(isDesktop
        ? {
            button: pointerMode === 'right' ? 'right' : 'left',
            clickCount: pointerMode === 'double' ? 2 : 1,
          }
        : {}),
    });
  }
  return { startTakeover, endTakeover, finish, manual, clickScreen };
}
