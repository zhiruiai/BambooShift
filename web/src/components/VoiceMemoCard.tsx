import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FilePreviewIdentity } from '../filePreview';
import { uiText } from '../i18n';
import { loadVoiceMemo, type messageVoiceMemo, voiceMemoTime } from '../voiceMemo';
import './VoiceMemo.css';

type Memo = NonNullable<ReturnType<typeof messageVoiceMemo>>;
type Audio = NonNullable<Memo['audio']>;
type PlaybackPhase = 'idle' | 'loading' | 'playing' | 'paused' | 'ready' | 'error';
const activeMemos = new Map<string, () => void>();

export function VoiceMemoCard({
  memo,
  scope,
  identity,
  current,
  blocked,
  speakingId,
  stopReading,
}: {
  memo: Memo;
  scope: string;
  identity: FilePreviewIdentity;
  current: () => boolean;
  blocked: boolean;
  speakingId?: string;
  stopReading: () => void;
}) {
  return (
    <section className="voice-memo-card" aria-label={uiText('workspace:voiceMemoTitle')}>
      <strong>{uiText('workspace:voiceMemoTitle')}</strong>
      {memo.audio && identity.userId && identity.workspaceId ? (
        <MemoPlayer
          key={JSON.stringify([scope, identity.pathname, memo.audio.id, memo.audio.sha256])}
          audio={memo.audio}
          durationMs={memo.durationMs}
          scope={scope}
          identity={identity}
          current={current}
          blocked={blocked}
          speakingId={speakingId}
          stopReading={stopReading}
        />
      ) : (
        <p className="voice-memo-hint">{uiText('workspace:voiceMemoAudioUnavailable')}</p>
      )}
      <details className="voice-memo-transcript">
        <summary>{uiText('workspace:voiceCallTranscript')}</summary>
        <p>{memo.transcript}</p>
      </details>
    </section>
  );
}

function MemoPlayer({
  audio,
  durationMs,
  scope,
  identity,
  current,
  blocked,
  speakingId,
  stopReading,
}: {
  audio: Audio;
  durationMs: number;
  scope: string;
  identity: FilePreviewIdentity;
  current: () => boolean;
  blocked: boolean;
  speakingId?: string;
  stopReading: () => void;
}) {
  const elementRef = useRef<HTMLAudioElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const objectUrl = useRef<string | undefined>(undefined);
  const latest = useRef({ current, blocked });
  latest.current = { current, blocked };
  const [phase, setPhase] = useState<PlaybackPhase>('idle');
  const [position, setPosition] = useState(0);
  const owner = useRef<() => void>(undefined);
  const release = useCallback(
    (update = true) => {
      if (activeMemos.get(scope) === owner.current) activeMemos.delete(scope);
      request.current?.abort();
      request.current = undefined;
      if (objectUrl.current) {
        URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = undefined;
        const element = elementRef.current;
        element?.pause();
        element?.removeAttribute('src');
        element?.load();
      }
      if (update) {
        setPosition(0);
        setPhase('idle');
      }
    },
    [scope],
  );
  useEffect(() => {
    const stop = () => release();
    owner.current = stop;
    const onVisibility = () => {
      if (document.hidden) stop();
    };
    const events = [
      'pagehide',
      'openbot:account-expired',
      'openbot:unpaired',
      'openbot:revalidate',
    ];
    events.forEach((event) => window.addEventListener(event, stop));
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      events.forEach((event) => window.removeEventListener(event, stop));
      document.removeEventListener('visibilitychange', onVisibility);
      release(false);
      owner.current = undefined;
    };
  }, [release]);
  useEffect(() => {
    if (blocked || speakingId) release();
  }, [blocked, speakingId, release]);

  const allowed = () =>
    !!owner.current &&
    latest.current.current() &&
    !latest.current.blocked &&
    !document.hidden &&
    window.location.pathname === identity.pathname;

  async function toggle() {
    const element = elementRef.current;
    if (!element || !allowed() || request.current || !owner.current) return;
    if (!element.paused) {
      element.pause();
      setPhase('paused');
      return;
    }
    stopReading();
    const previous = activeMemos.get(scope);
    if (previous && previous !== owner.current) previous();
    activeMemos.set(scope, owner.current);
    const controller = new AbortController();
    request.current = controller;
    setPhase('loading');
    const valid = () => request.current === controller && allowed();
    try {
      if (!objectUrl.current) {
        const blob = await loadVoiceMemo(audio, durationMs, identity, controller.signal, valid);
        if (!valid()) return;
        objectUrl.current = URL.createObjectURL(blob);
        element.src = objectUrl.current;
      }
      await element.play();
      if (valid()) setPhase('playing');
    } catch (error) {
      if (!valid()) return;
      if (objectUrl.current && error instanceof DOMException && error.name === 'NotAllowedError') {
        setPhase('ready');
      } else {
        release();
        setPhase('error');
      }
    } finally {
      if (request.current === controller) {
        if (!allowed()) release();
        else request.current = undefined;
      }
    }
  }

  const duration = durationMs / 1000;
  const label = uiText(
    phase === 'playing' ? 'workspace:voiceMemoPause' : 'workspace:voiceMemoPlay',
  );
  const hint =
    phase === 'loading'
      ? uiText('workspace:voiceMemoLoading')
      : phase === 'ready'
        ? uiText('workspace:voiceMemoReady')
        : phase === 'error'
          ? uiText('workspace:voiceMemoPlaybackError')
          : undefined;
  return (
    <>
      <div className="voice-memo-controls">
        <button
          type="button"
          className="voice-memo-play"
          aria-label={label}
          title={label}
          disabled={blocked || phase === 'loading'}
          onClick={() => void toggle()}
        >
          {phase === 'playing' ? (
            <Pause size={16} aria-hidden="true" />
          ) : (
            <Play size={16} aria-hidden="true" />
          )}
        </button>
        <input
          type="range"
          aria-label={uiText('workspace:voiceMemoSeek')}
          aria-valuetext={voiceMemoTime(position)}
          min={0}
          max={duration}
          step={0.001}
          value={Math.min(position, duration)}
          disabled={blocked || !objectUrl.current || phase === 'loading' || phase === 'error'}
          onChange={(event) => {
            const element = elementRef.current;
            if (!element || !allowed() || !Number.isFinite(element.duration)) return;
            element.currentTime = Math.min(event.target.valueAsNumber, element.duration);
            setPosition(element.currentTime);
          }}
        />
        <span className="voice-memo-time">
          {voiceMemoTime(position)} / {voiceMemoTime(duration)}
        </span>
      </div>
      {hint && (
        <p className="voice-memo-hint" role="status">
          {hint}
        </p>
      )}
      <audio
        ref={elementRef}
        preload="none"
        onTimeUpdate={(event) => {
          if (objectUrl.current && allowed()) setPosition(event.currentTarget.currentTime);
        }}
        onEnded={() => {
          if (objectUrl.current && allowed()) setPhase('paused');
        }}
        onError={() => {
          if (!objectUrl.current || !allowed()) return;
          release();
          setPhase('error');
        }}
      />
    </>
  );
}
