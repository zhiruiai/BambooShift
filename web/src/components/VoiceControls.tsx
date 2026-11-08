import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, Square, Volume2, X } from 'lucide-react';
import type { Message } from '../../../shared/types';
import { uiText } from '../i18n';
import type { WorkspaceVoice } from '../useVoice';
import { canReadMessage } from '../voicePlayback';
import './VoiceControls.css';

export function voiceStatus(voice: WorkspaceVoice) {
  if (!voice.state.supported) return uiText('workspace:voiceUnsupported');
  if (!voice.state.voices.length) return uiText('workspace:voiceNoLocal');
  if (
    voice.state.voiceURI &&
    !voice.state.voices.some((item) => item.voiceURI === voice.state.voiceURI)
  )
    return uiText('workspace:voiceMissing');
  if (voice.state.error === 'failed') return uiText('workspace:voiceFailed');
  return '';
}
export function VoiceMessageButton({
  voice,
  message,
  showLabel,
  onActivate,
}: {
  voice: WorkspaceVoice;
  message: Message;
  showLabel?: boolean;
  onActivate?: () => boolean;
}) {
  if (!canReadMessage(message)) return null;
  const speaking = voice.state.speakingId === message.id;
  const unavailable = voiceStatus(voice);
  const label = speaking ? uiText('workspace:voiceStopReading') : uiText('workspace:voiceRead');
  return (
    <button
      type="button"
      aria-label={label}
      title={voice.blocked ? uiText('workspace:voiceRecording') : unavailable || label}
      disabled={voice.blocked || !voice.state.supported || !voice.state.voices.length}
      aria-pressed={speaking}
      onClick={() => {
        if (onActivate && !onActivate()) return;
        if (speaking) voice.stopReading();
        else voice.read(message);
      }}
    >
      {speaking ? <Square size={12} /> : <Volume2 size={13} />}
      {showLabel && <span>{label}</span>}
    </button>
  );
}
export function VoiceControls({
  voice,
  blocked,
  onStop,
}: {
  voice: WorkspaceVoice;
  blocked: boolean;
  onStop(): void;
}) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  const show = (value: boolean) => {
    openRef.current = value;
    setOpen(value);
  };
  const root = useRef<HTMLDivElement | null>(null),
    trigger = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) show(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      show(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    root.current?.addEventListener('keydown', key);
    const container = root.current;
    return () => {
      document.removeEventListener('pointerdown', outside);
      container?.removeEventListener('keydown', key);
    };
  }, [open]);
  const act = (callback: () => void) => {
    if (mounted.current && openRef.current) callback();
  };
  const status = voiceStatus(voice),
    unavailable = !voice.state.supported || !voice.state.voices.length;
  return (
    <div className="voice-controls" ref={root}>
      <button
        type="button"
        className="dictation-button"
        ref={trigger}
        aria-label={uiText('workspace:voiceSettings')}
        title={uiText('workspace:voiceSettings')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (mounted.current) show(!openRef.current);
        }}
      >
        <SlidersHorizontal size={16} />
      </button>
      {voice.state.speakingId && (
        <button
          type="button"
          className="dictation-button"
          aria-label={uiText('workspace:voiceStopAll')}
          title={uiText('workspace:voiceStopAll')}
          onClick={onStop}
        >
          <Square size={13} />
        </button>
      )}
      {open && (
        <div className="voice-popover" role="dialog" aria-label={uiText('workspace:voiceSettings')}>
          <header>
            <strong>{uiText('workspace:voiceSettings')}</strong>
            <button
              type="button"
              aria-label={uiText('workspace:voiceClose')}
              onClick={() => {
                show(false);
                trigger.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          </header>
          <p>{uiText('workspace:voiceDescription')}</p>
          {status && <p role="status">{status}</p>}
          <label>
            {uiText('workspace:voiceVoice')}
            <select
              value={voice.state.voiceURI}
              disabled={blocked || unavailable}
              onChange={(event) => act(() => voice.update({ voiceURI: event.target.value }))}
            >
              <option value="">{uiText('workspace:voiceAutomatic')}</option>
              {!!voice.state.voiceURI &&
                !voice.state.voices.some((item) => item.voiceURI === voice.state.voiceURI) && (
                  <option value={voice.state.voiceURI}>
                    {uiText('workspace:voiceMissingOption')}
                  </option>
                )}
              {voice.state.voices.map((item) => (
                <option key={item.voiceURI} value={item.voiceURI}>
                  {item.name} · {item.lang}
                </option>
              ))}
            </select>
          </label>
          <label>
            {uiText('workspace:voiceRate')}
            <select
              value={voice.state.rate}
              disabled={blocked || unavailable}
              onChange={(event) => act(() => voice.update({ rate: Number(event.target.value) }))}
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </select>
          </label>
          <label className="voice-check">
            <input
              type="checkbox"
              checked={voice.state.autoRead}
              disabled={blocked || unavailable}
              onChange={(event) => act(() => voice.update({ autoRead: event.target.checked }))}
            />
            {uiText('workspace:voiceAutoRead')}
          </label>
          <p>{uiText('workspace:voiceSessionHelp')}</p>
          {voice.state.autoRead && (
            <button
              type="button"
              className="primary-button"
              disabled={blocked || unavailable}
              onClick={() => act(() => (voice.state.armed ? onStop() : voice.arm()))}
            >
              {voice.state.armed
                ? uiText('workspace:voiceEndSession')
                : uiText('workspace:voiceStartSession')}
            </button>
          )}
          {(blocked || voice.state.speakingId) && (
            <button type="button" className="text-button" onClick={() => act(onStop)}>
              {uiText('workspace:voiceStopAll')}
            </button>
          )}
          <button type="button" className="text-button" onClick={() => act(voice.refresh)}>
            {uiText('workspace:voiceRefresh')}
          </button>
          {!voice.state.storageAvailable && <p role="status">{uiText('workspace:voiceStorage')}</p>}
          <small>{uiText('workspace:voicePrivacy')}</small>
        </div>
      )}
    </div>
  );
}
