import { Copy, RefreshCw, Webhook } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { uiText } from '../../i18n';
import { createRoutineWebhookClient, type RoutineWebhookState } from '../../routineWebhooks';
import './RoutineWebhookPanel.css';

type Props = { routineId: string; workspaceId?: string; userId?: string; disabled?: boolean };

export function RoutineWebhookPanel(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <section className="routine-webhook-panel" aria-label={uiText('routines:webhookTrigger')}>
      <button
        type="button"
        className="secondary-button"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Webhook size={15} aria-hidden="true" /> {uiText('routines:webhookTrigger')}
      </button>
      {open && <WebhookSettings {...props} />}
    </section>
  );
}

function WebhookSettings(props: Props) {
  const identity = useRef(props);
  identity.current = props;
  const [state, setState] = useState<RoutineWebhookState>({ busy: false });
  const [confirmation, setConfirmation] = useState<{
    method: 'PUT' | 'DELETE';
    revision: string;
  }>();
  const [client] = useState(() =>
    createRoutineWebhookClient({
      ...props,
      identity: () => identity.current,
      canReveal: () => !document.hidden,
      onState: setState,
    }),
  );
  useEffect(() => {
    client.resume();
    void client.read();
    const discardOnHide = () => {
      if (document.hidden) client.discardSecret();
    };
    const discardOnLeave = () => flushSync(client.discardSecret);
    document.addEventListener('visibilitychange', discardOnHide);
    window.addEventListener('pagehide', discardOnLeave);
    window.addEventListener('openbot:account-expired', client.discardSecret);
    window.addEventListener('openbot:revalidate', client.discardSecret);
    return () => {
      client.suspend();
      document.removeEventListener('visibilitychange', discardOnHide);
      window.removeEventListener('pagehide', discardOnLeave);
      window.removeEventListener('openbot:account-expired', client.discardSecret);
      window.removeEventListener('openbot:revalidate', client.discardSecret);
    };
  }, [client]);

  const { config, busy, secret, notice } = state;
  const disabled = props.disabled || busy;
  const labels = {
    changed: 'routines:webhookChanged',
    unknown: 'routines:webhookUnknown',
    readFailed: 'routines:webhookReadFailed',
    revoked: 'routines:webhookRevoked',
  } as const;
  const endpoint = config?.enabled ? new URL(config.path, window.location.origin).href : undefined;
  const update = (method: 'PUT' | 'DELETE', revision: string) => {
    if (disabled || !client.current()) return;
    setConfirmation(undefined);
    void client.write(method, revision);
  };

  return (
    <div className="routine-webhook-settings">
      <p className="field-help">{uiText('routines:webhookInstructions')}</p>
      {busy && <p role="status">{uiText('common:loading')}</p>}
      {notice && <p role={notice === 'revoked' ? 'status' : 'alert'}>{uiText(labels[notice])}</p>}
      {config && (
        <strong>
          {uiText(config.enabled ? 'routines:webhookActive' : 'routines:webhookInactive')}
        </strong>
      )}
      {endpoint && (
        <WebhookCredential
          label={uiText('routines:webhookEndpoint')}
          copyLabel={uiText('routines:webhookCopyEndpoint')}
          value={endpoint}
          disabled={disabled}
        />
      )}
      {secret && (
        <div className="routine-webhook-key">
          <p className="field-help">{uiText('routines:webhookKeyOnce')}</p>
          <WebhookCredential
            key={config?.revision}
            label={uiText('routines:webhookKey')}
            copyLabel={uiText('routines:webhookCopyKey')}
            value={secret}
            disabled={disabled}
          />
          <button type="button" className="secondary-button" onClick={client.discardSecret}>
            {uiText('routines:webhookHideKey')}
          </button>
        </div>
      )}
      {confirmation ? (
        <div
          className="routine-webhook-confirm"
          role="group"
          aria-label={uiText('routines:webhookConfirmTitle')}
        >
          <p>
            {uiText(
              confirmation.method === 'PUT'
                ? 'routines:webhookRotateHelp'
                : 'routines:webhookRevokeHelp',
            )}
          </p>
          <div className="routine-webhook-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirmation(undefined)}
            >
              {uiText('common:cancel')}
            </button>
            <button
              type="button"
              className={confirmation.method === 'DELETE' ? 'danger-button' : 'primary-button'}
              disabled={disabled}
              onClick={() => update(confirmation.method, confirmation.revision)}
            >
              {uiText(
                confirmation.method === 'PUT'
                  ? 'routines:webhookConfirmRotate'
                  : 'routines:webhookConfirmRevoke',
              )}
            </button>
          </div>
        </div>
      ) : (
        <div className="routine-webhook-actions">
          {config &&
            (config.enabled ? (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={disabled}
                  onClick={() => setConfirmation({ method: 'PUT', revision: config.revision })}
                >
                  {uiText('routines:webhookRotate')}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={disabled}
                  onClick={() => setConfirmation({ method: 'DELETE', revision: config.revision })}
                >
                  {uiText('routines:webhookRevoke')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="primary-button"
                disabled={disabled}
                onClick={() => update('PUT', config.revision)}
              >
                {uiText('routines:webhookCreate')}
              </button>
            ))}
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() => void client.read()}
          >
            <RefreshCw size={14} aria-hidden="true" /> {uiText('routines:webhookRefresh')}
          </button>
        </div>
      )}
    </div>
  );
}

function WebhookCredential({
  label,
  copyLabel,
  value,
  disabled,
}: {
  label: string;
  copyLabel: string;
  value: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'copied' | 'manual'>();
  return (
    <div className="routine-webhook-credential">
      <label>
        {label}
        <input
          ref={input}
          value={value}
          readOnly
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={disabled}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setStatus('copied');
          } catch {
            input.current?.focus();
            input.current?.select();
            setStatus('manual');
          }
        }}
      >
        <Copy size={14} aria-hidden="true" /> {copyLabel}
      </button>
      {status && (
        <p role="status">
          {uiText(status === 'copied' ? 'routines:webhookCopied' : 'routines:webhookManualCopy')}
        </p>
      )}
    </div>
  );
}
