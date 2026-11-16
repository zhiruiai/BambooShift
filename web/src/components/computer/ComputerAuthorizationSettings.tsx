import { useEffect, useId, useRef, useState } from 'react';
import { Check, Loader2, ShieldCheck } from 'lucide-react';
import type { createComputerScope } from '../../computerScope';
import { uiText } from '../../i18n';
import { serviceText } from '../../i18n/serviceText';
import './ComputerAuthorizationSettings.css';

export type ComputerAuthorization = {
  mode: 'confirm' | 'full';
  targetRevision: string | null;
  targetName: string | null;
  canManage: boolean;
  scope: 'current-user-current-computer';
  grantedAt?: string;
};

export function ComputerAuthorizationSettings({
  scope,
  targetRevision,
  targetName,
  disabled,
  onBusyChange,
}: {
  scope: ReturnType<typeof createComputerScope>;
  targetRevision: string;
  targetName: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const titleId = useId();
  const [state, setState] = useState<ComputerAuthorization>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const sequence = useRef(0);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  function accept(value: ComputerAuthorization) {
    if (value.targetRevision !== targetRevision)
      throw new Error(uiText('computer:authorizationChanged'));
    setState(value);
  }
  async function read(clearError = false) {
    if (pending.current) return;
    const request = ++sequence.current;
    try {
      const result = await scope.request<ComputerAuthorization>(
        '/authorization',
        'GET',
        undefined,
        true,
      );
      if (!mounted.current || request !== sequence.current) return;
      accept(result);
      if (clearError) setError('');
    } catch (cause) {
      if (mounted.current && request === sequence.current) {
        setState(undefined);
        setError(serviceText((cause as Error).message));
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void read();
    const refresh = () => {
      if (!document.hidden) void read(true);
    };
    const timer = setInterval(refresh, 4000);
    window.addEventListener('focus', refresh);
    return () => {
      mounted.current = false;
      sequence.current++;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      if (pending.current) busyCallback.current(false);
    };
  }, [scope, targetRevision]);

  async function change(mode: ComputerAuthorization['mode']) {
    if (
      pending.current ||
      (disabled && mode === 'full') ||
      !state?.canManage ||
      state.mode === mode
    )
      return;
    pending.current = true;
    sequence.current++;
    setSaving(true);
    setError('');
    busyCallback.current(true);
    try {
      const result = await scope.request<ComputerAuthorization>(
        '/authorization',
        'POST',
        { mode, expectedTargetRevision: targetRevision },
        true,
      );
      if (mounted.current) accept(result);
    } catch (cause) {
      if (mounted.current) {
        setState(undefined);
        setError(serviceText((cause as Error).message));
      }
    } finally {
      pending.current = false;
      if (mounted.current) {
        setSaving(false);
        busyCallback.current(false);
        // A lost response may still have saved the choice. Re-read, never replay it.
        void read();
      }
    }
  }
  const full = state?.mode === 'full';
  return (
    <section className="computer-authorization" aria-labelledby={titleId} aria-busy={saving}>
      <div className="computer-authorization-heading">
        <ShieldCheck size={18} aria-hidden="true" />
        <h3 id={titleId}>{uiText('computer:authorizationTitle')}</h3>
        {saving ? (
          <span role="status">
            <Loader2 size={14} className="spin" aria-hidden="true" />
            {uiText('computer:authorizationSaving')}
          </span>
        ) : (
          <span role="status">
            {uiText(
              !state
                ? 'computer:authorizationUnknown'
                : full
                  ? 'computer:authorizationFullStatus'
                  : 'computer:authorizationConfirmStatus',
            )}
          </span>
        )}
      </div>
      <p>{uiText('computer:authorizationScope', { name: state?.targetName || targetName })}</p>
      <details open={!full || !scope.baseUrl}>
        <summary>{uiText('computer:authorizationManageDefault')}</summary>
        <div
          className="computer-authorization-options"
          role="group"
          aria-label={uiText('computer:authorizationTitle')}
        >
          {(['confirm', 'full'] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              aria-pressed={state?.mode === mode}
              disabled={saving || !state?.canManage || (disabled && mode === 'full')}
              onClick={() => void change(mode)}
            >
              <strong>
                {uiText(
                  mode === 'full' ? 'computer:authorizationFull' : 'computer:authorizationConfirm',
                )}
                {state?.mode === mode && <Check size={15} aria-hidden="true" />}
              </strong>
              <span>
                {uiText(
                  mode === 'full'
                    ? 'computer:authorizationFullHelp'
                    : 'computer:authorizationConfirmHelp',
                )}
              </span>
            </button>
          ))}
        </div>
        <p>
          {uiText(
            full ? 'computer:authorizationRevokeHelp' : 'computer:authorizationCapabilityHelp',
          )}
        </p>
      </details>
      {state && !state.canManage && <p>{uiText('computer:authorizationOwnerOnly')}</p>}
      {error && (
        <div className="computer-authorization-error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="text-button"
            disabled={saving}
            onClick={() => void read(true)}
          >
            {uiText('computer:authorizationRefresh')}
          </button>
        </div>
      )}
    </section>
  );
}
