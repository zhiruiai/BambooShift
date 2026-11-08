import { serviceText } from '../i18n/serviceText';
import { currentLanguage } from '../i18n';
import { uiText } from '../i18n';
import { ApiError } from '../api';
import { PRIVATE_FRAME_DENIED, readScreenFrame } from '../computerFrameMedia';
import { createComputerScope, screenIdentity } from '../computerScope';
import { useEffect, useState } from 'react';
import { ChevronRight, Maximize2, Monitor } from 'lucide-react';
import type { ComputerState } from '../../../shared/types';

type Frame = { scopeKey: string; url: string; capturedAt: string };
/** Private, periodically refreshed screenshot. Object URLs never leave this component. */
export function ComputerPreview({
  computer,
  onOpen,
  active = true,
  agentName,
  workspaceId,
  userId,
}: {
  computer: ComputerState;
  onOpen: () => void;
  active?: boolean;
  agentName?: string;
  workspaceId?: string;
  userId?: string;
}) {
  const [savedFrame, setFrame] = useState<Frame | null>(null),
    [error, setError] = useState(''),
    [masked, setMasked] = useState(false),
    [loading, setLoading] = useState(false);
  const identity = screenIdentity(computer);
  const scopeKey = JSON.stringify([workspaceId, userId, computer.botScreen?.agentId, identity]);
  const frame = active && savedFrame?.scopeKey === scopeKey ? savedFrame : null;
  useEffect(() => {
    setFrame(null);
    setError('');
    setMasked(false);
    setLoading(false);
  }, [scopeKey, active]);
  useEffect(
    () => () => {
      if (savedFrame) URL.revokeObjectURL(savedFrame.url);
    },
    [savedFrame],
  );
  useEffect(() => {
    if (
      !computer.connected ||
      computer.botScreen?.status !== 'ready' ||
      computer.botScreen.lifecycle?.operation ||
      computer.botScreen.lifecycle?.state === 'changing' ||
      computer.botScreen.lifecycle?.state === 'blocked' ||
      !active
    )
      return;
    const scope = createComputerScope({ workspaceId, userId, agentId: computer.botScreen.agentId });
    let alive = true,
      inFlight = false,
      controller: AbortController | null = null;
    async function capture() {
      if (!alive || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      setLoading(true);
      const request = new AbortController();
      controller = request;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        request.abort();
      }, 10000);
      try {
        const response = await scope.response('/screenshot', {
          signal: request.signal,
          redirect: 'error',
        });
        const { blob, capturedAt } = await readScreenFrame(
          response,
          'shared',
          () => alive && !request.signal.aborted,
        );
        if (!alive || request.signal.aborted) return;
        setFrame({
          scopeKey,
          url: URL.createObjectURL(blob),
          capturedAt,
        });
        setMasked(false);
        setError('');
      } catch (cause) {
        if (alive && (!request.signal.aborted || timedOut)) {
          const privateFrame = cause instanceof ApiError && cause.code === PRIVATE_FRAME_DENIED;
          if (privateFrame) setFrame(null);
          setMasked(privateFrame);
          setError(
            privateFrame
              ? uiText('computer:privateTakeoverMasked')
              : timedOut
                ? uiText('computer:text_b5ac0a4ba579')
                : (cause as Error).message,
          );
        }
      } finally {
        clearTimeout(timeout);
        if (controller === request) controller = null;
        inFlight = false;
        if (alive) setLoading(false);
      }
    }
    function visibility() {
      if (document.visibilityState === 'visible') void capture();
      else controller?.abort();
    }
    void capture();
    const interval = setInterval(() => void capture(), 12000);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      alive = false;
      scope.dispose();
      clearInterval(interval);
      controller?.abort();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [scopeKey, active]);
  const capturedTime = frame
    ? new Date(frame.capturedAt).toLocaleTimeString(currentLanguage(), { hour12: false })
    : '';
  return (
    <button
      type="button"
      className="computer-preview"
      onClick={onOpen}
      aria-label={
        agentName
          ? uiText('computer:text_9df56e911035', { value0: agentName })
          : uiText('computer:text_aca0cc6f14ba')
      }
      title={
        error || serviceText(computer.botScreen?.reason) || uiText('computer:text_f3e471df818f')
      }
    >
      <div className={`mini-desktop ${frame ? 'preview-real-screen' : ''}`}>
        {frame ? (
          <img
            src={frame.url}
            alt={uiText('computer:text_336b1fe7dc3d', {
              value0:
                computer.surface === 'desktop'
                  ? uiText('computer:text_f48d334495f6')
                  : uiText('computer:text_e19c3b9e266c'),
              value1: capturedTime,
              value2: error ? uiText('computer:text_62176b3b6106') : '',
            })}
          />
        ) : (
          <div className="preview-empty-screen">
            <Monitor size={28} />
            <span>
              {(masked
                ? uiText('computer:privateTakeoverMasked')
                : serviceText(computer.botScreen?.reason)) ||
                (!computer.botScreen
                  ? uiText('computer:text_a65739ba8d64')
                  : computer.botScreen.status === 'unassigned'
                    ? uiText('computer:text_433ca819520d')
                    : loading
                      ? uiText('computer:text_76e9e1056922')
                      : uiText('computer:text_ba80c39abfa7'))}
            </span>
          </div>
        )}
        <span className="preview-overlay">
          <Maximize2 size={14} />
          {uiText('computer:text_ac3a0dd5959d')}
        </span>
      </div>
      <div className="computer-caption">
        <Monitor size={13} />
        <span>
          {agentName
            ? uiText('computer:text_60e92744fead', { value0: agentName })
            : uiText('computer:text_aca0cc6f14ba')}
        </span>
        <ChevronRight size={13} />
      </div>
      <div className={`preview-frame-status ${error ? 'is-stale' : ''}`}>
        <span>
          {frame
            ? `${computer.surface === 'desktop' ? uiText('computer:text_6e0f793043a9') : ''}${error ? uiText('computer:text_0195979e9923') : uiText('computer:text_6f1d3f20cf25')} ${capturedTime}`
            : !computer.connected
              ? computer.botScreen?.status === 'unassigned'
                ? uiText('computer:text_3ae70dbf1408')
                : uiText('computer:text_ba85d5247c8d')
              : loading
                ? uiText('computer:text_fb4ffbf3772c')
                : uiText('computer:text_e4bd715be09c')}
        </span>
        <small>
          {frame
            ? error
              ? uiText('computer:text_ec99e5c45d64')
              : uiText('computer:text_c7ad9eb5b629')
            : error
              ? uiText('computer:text_80a340643091')
              : ''}
        </small>
      </div>
    </button>
  );
}
