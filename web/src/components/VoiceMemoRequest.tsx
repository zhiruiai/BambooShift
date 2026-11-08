import { Volume2 } from 'lucide-react';
import { uiText } from '../i18n';
import './VoiceMemo.css';

export function VoiceMemoSelection({ eligible, queued }: { eligible: boolean; queued: boolean }) {
  return (
    <div className="composer-delivery-mode" role="status">
      {uiText(
        !eligible
          ? 'workspace:voiceMemoRequestUnavailable'
          : queued
            ? 'workspace:voiceMemoRequestQueued'
            : 'workspace:voiceMemoRequestSelected',
      )}
    </div>
  );
}

export function VoiceMemoRequest({
  active,
  disabled,
  onChange,
}: {
  active: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  const label = uiText('workspace:voiceMemoRequest');
  return (
    <button
      type="button"
      className="icon-button voice-memo-request"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onChange}
    >
      <Volume2 size={16} aria-hidden="true" />
    </button>
  );
}
