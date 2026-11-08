import { serviceText } from '../i18n/serviceText';
import { uiText } from '../i18n';
import { Check, Loader2, Mic, Square, X } from 'lucide-react';
import type { DictationState } from '../dictation';
import './DictationControls.css';

export function DictationButton({
  state,
  disabled,
  onToggle,
}: {
  state: DictationState;
  disabled: boolean;
  onToggle(): void;
}) {
  const recording = state.phase === 'recording';
  const waiting = state.phase === 'requesting' || state.phase === 'transcribing';
  return (
    <button
      type="button"
      className={`dictation-button ${recording ? 'is-recording' : ''}`}
      aria-label={
        recording ? uiText('common:text_1a88e8dfa4b2') : uiText('common:text_2fdc91e671fd')
      }
      title={recording ? uiText('common:text_1a88e8dfa4b2') : uiText('common:text_477461fbf715')}
      aria-pressed={recording}
      disabled={disabled || waiting}
      onClick={onToggle}
    >
      {waiting ? (
        <Loader2 size={17} className="spin" />
      ) : recording ? (
        <Square size={14} fill="currentColor" />
      ) : (
        <Mic size={18} />
      )}
    </button>
  );
}

export function DictationStatus({
  state,
  onFinish,
  onCancel,
  onDismiss,
  onCheck,
}: {
  state: DictationState;
  onFinish(): void;
  onCancel(): void;
  onDismiss(): void;
  onCheck(): void;
}) {
  const active = ['requesting', 'recording', 'transcribing'].includes(state.phase);
  if (!active && !state.error && !state.notice) return null;
  const seconds = Math.min(60, Math.floor(state.durationMs / 1000));
  const label =
    state.phase === 'requesting'
      ? uiText('common:text_fcaa6b79c2e4')
      : state.phase === 'recording'
        ? uiText('common:text_7b42c5dc0ee8', {
            value0: String(Math.floor(seconds / 60)).padStart(2, '0'),
            value1: String(seconds % 60).padStart(2, '0'),
          })
        : state.phase === 'transcribing'
          ? uiText('common:text_2648af59a3e7')
          : serviceText(state.error || state.notice);
  return (
    <div className={`dictation-status ${state.error ? 'has-error' : ''}`}>
      <div className="dictation-status-copy">
        <span role="status" aria-live="polite">
          {label}
        </span>
        {active && <small>{uiText('common:text_806cf4f2115e')}</small>}
      </div>
      <div className="dictation-status-actions">
        {state.phase === 'recording' && (
          <button type="button" onClick={onFinish}>
            <Check size={14} />
            {uiText('common:text_fe7844a6edf5')}
          </button>
        )}
        {active ? (
          <button type="button" onClick={onCancel}>
            {uiText('common:text_2cd0f3be8738')}
          </button>
        ) : (
          <>
            {state.error && (
              <button type="button" onClick={onCheck}>
                {uiText('common:text_167f9a218423')}
              </button>
            )}
            <button
              type="button"
              aria-label={uiText('common:text_704b4ee61645')}
              onClick={onDismiss}
            >
              <X size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
