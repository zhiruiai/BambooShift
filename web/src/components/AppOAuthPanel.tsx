import { serviceText } from '../i18n/serviceText';
import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import type { ConnectedApp } from '../../../shared/app-connections';
import type { AppOAuthFlow, StartAppOAuth } from '../../../shared/app-oauth';
import { createAppConnectionScope } from '../appConnections';
import { appAuthorizationPath, oauthPending, oauthPhaseLabel } from '../appOAuth';

type Props = {
  app: ConnectedApp;
  workspaceId?: string;
  userId?: string;
  disabled?: boolean;
  onBusy: (busy: boolean) => void;
  onChanged: () => void;
};
export function AppOAuthPanel(props: Props) {
  return <OAuthPanel key={`${props.userId}:${props.workspaceId}:${props.app.id}`} {...props} />;
}
function OAuthPanel({ app, workspaceId, userId, disabled = false, onBusy, onChanged }: Props) {
  const [scope] = useState(() => createAppConnectionScope({ workspaceId, userId }));
  const [flow, setFlow] = useState<AppOAuthFlow | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState(false);
  const [clientId, setClientId] = useState(''),
    [clientSecret, setClientSecret] = useState('');
  const running = useRef(false),
    sequence = useRef(0),
    uncertainRef = useRef(false),
    latest = useRef({ flow, app, disabled, loading, onBusy, onChanged });
  latest.current = { flow, app, disabled, loading, onBusy, onChanged };
  const root = `/apps/${encodeURIComponent(app.id)}/oauth`;
  const native = typeof window !== 'undefined' && !!window.openbotAuthorization;
  const desktop =
    typeof document !== 'undefined' && document.documentElement?.dataset.openbotDesktop === 'true';
  async function read() {
    if (running.current) return;
    const ticket = scope.ticket(),
      id = ++sequence.current;
    if (!scope.current(ticket)) return;
    setLoading(true);
    try {
      const result = await scope.request<AppOAuthFlow | null>(root);
      if (!scope.current(ticket) || id !== sequence.current) return;
      setFlow(result);
      setError('');
      setUncertain(false);
      uncertainRef.current = false;
      if (
        result?.status === 'complete' &&
        latest.current.app.status !== 'connected' &&
        !latest.current.disabled
      )
        latest.current.onChanged();
    } catch (cause) {
      if (scope.current(ticket) && id === sequence.current) setError((cause as Error).message);
    } finally {
      if (scope.current(ticket) && id === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    scope.resume();
    void read();
    const refresh = () => {
      if (!document.hidden) void read();
    };
    const timer = setInterval(() => {
      if (!document.hidden && latest.current.flow && oauthPending(latest.current.flow.status))
        void read();
    }, 3000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      scope.suspend();
      sequence.current++;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      latest.current.onBusy(false);
    };
  }, [scope]);
  async function mutate(kind: 'start' | 'finish' | 'cancel') {
    const ticket = scope.ticket(),
      current = latest.current.flow;
    if (
      !scope.current(ticket) ||
      running.current ||
      uncertainRef.current ||
      latest.current.disabled ||
      latest.current.loading
    )
      return;
    if (kind === 'start' && current && oauthPending(current.status)) return;
    if (kind === 'finish' && current?.status !== 'callback_received') return;
    if (kind === 'cancel' && (!current || !oauthPending(current.status))) return;
    running.current = true;
    sequence.current++;
    setBusy(true);
    setError('');
    latest.current.onBusy(true);
    try {
      const body: StartAppOAuth | Record<string, never> =
        kind === 'start'
          ? {
              expectedRevision: latest.current.app.revision,
              ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
              ...(clientSecret ? { clientSecret } : {}),
            }
          : {};
      const result = await scope.request<AppOAuthFlow>(
        kind === 'start' ? `${root}/start` : `${root}/${encodeURIComponent(current!.id)}/${kind}`,
        'POST',
        body,
      );
      if (!scope.current(ticket)) return;
      setFlow(result);
      setClientSecret('');
      if (result.status === 'complete') latest.current.onChanged();
    } catch (cause) {
      if (!scope.current(ticket)) return;
      setError((cause as Error).message);
      setUncertain(true);
      uncertainRef.current = true;
    } finally {
      running.current = false;
      if (scope.current(ticket)) {
        setBusy(false);
        setLoading(false);
        latest.current.onBusy(false);
      }
    }
  }
  async function openNative() {
    const current = latest.current.flow,
      ticket = scope.ticket();
    if (
      !scope.current(ticket) ||
      running.current ||
      latest.current.disabled ||
      uncertainRef.current ||
      !workspaceId ||
      !userId ||
      current?.status !== 'pending' ||
      !window.openbotAuthorization
    )
      return;
    running.current = true;
    setBusy(true);
    setError('');
    latest.current.onBusy(true);
    try {
      await window.openbotAuthorization.open({
        workspaceId,
        connectionId: app.id,
        flowId: current.id,
        expectedUserId: userId,
      });
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) {
        setBusy(false);
        latest.current.onBusy(false);
      }
    }
  }
  let path = '';
  if (workspaceId && flow?.status === 'pending') {
    try {
      const expected = appAuthorizationPath(workspaceId, app.id, flow.id);
      if (flow.launchPath === expected) path = expected;
    } catch {
      /* Invalid identities never become links. */
    }
  }
  return (
    <section className="apps-oauth" aria-label={uiText('apps:text_6328ea1156ca')}>
      <h3>{uiText('apps:text_6328ea1156ca')}</h3>
      <p className="field-help">{uiText('apps:text_7fad5b589aa2')}</p>
      {flow && (
        <>
          <p className="apps-notice" role="status">
            {oauthPhaseLabel(flow.status)}
          </p>
          {flow.authorizationOrigin && (
            <p className="field-help">
              {uiText('apps:text_086656b9ad4b')}
              {flow.authorizationOrigin}
            </p>
          )}
          {flow.scopes.length > 0 && (
            <details>
              <summary>{uiText('apps:text_2b736907d5db')}</summary>
              <ul>
                {flow.scopes.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
          )}
          {flow.error && <p className="error-text">{serviceText(flow.error)}</p>}
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {uncertain && <p className="field-help">{uiText('apps:text_95ce0979462c')}</p>}
      {(!flow || !oauthPending(flow.status)) && (
        <>
          <details>
            <summary>{uiText('apps:text_63a336a4fa29')}</summary>
            <div className="dialog-form">
              <label>
                {uiText('apps:text_92ceb36a3d2c')}
                <input
                  value={clientId}
                  disabled={busy || disabled}
                  autoComplete="off"
                  onChange={(event) => setClientId(event.target.value)}
                />
              </label>
              <label>
                {uiText('apps:text_7183484f9a9f')}
                <input
                  type="password"
                  value={clientSecret}
                  disabled={busy || disabled}
                  autoComplete="new-password"
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </label>
              <p className="field-help">{uiText('apps:text_a320606c981d')}</p>
            </div>
          </details>
          <button
            type="button"
            className="primary-button"
            disabled={busy || disabled || loading || uncertain || !workspaceId || !userId}
            onClick={() => void mutate('start')}
          >
            {busy && <Loader2 size={14} className="spin" />}
            {app.status === 'connected'
              ? uiText('apps:text_6a84698a4758')
              : uiText('apps:text_86efc5f61c63')}
          </button>
        </>
      )}
      <div className="apps-controls">
        {flow?.status === 'pending' &&
          (native ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy || disabled || uncertain}
              onClick={() => void openNative()}
            >
              <ExternalLink size={14} />
              {uiText('apps:text_003d1bd15f51')}
            </button>
          ) : desktop ? (
            <p className="error-text">{uiText('apps:text_29eda08cfb92')}</p>
          ) : path ? (
            <a
              className="primary-button"
              href={path}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                if (busy || disabled || uncertain) event.preventDefault();
              }}
              aria-disabled={busy || disabled || uncertain}
            >
              <ExternalLink size={14} />
              {uiText('apps:text_003d1bd15f51')}
            </a>
          ) : (
            <p className="field-help">{uiText('apps:text_c32ab497e1c5')}</p>
          ))}
        {flow?.status === 'callback_received' && (
          <button
            type="button"
            className="primary-button"
            disabled={busy || disabled || loading || uncertain}
            onClick={() => void mutate('finish')}
          >
            {busy && <Loader2 size={14} className="spin" />}
            {uiText('apps:text_f7d7babf4661')}
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={busy || disabled || loading}
          onClick={() => void read()}
        >
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
          {uiText('apps:text_90b0a90e2226')}
        </button>
        {flow && oauthPending(flow.status) && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy || disabled || loading || uncertain}
            onClick={() => void mutate('cancel')}
          >
            {uiText('apps:text_a1c8374300e2')}
          </button>
        )}
      </div>
    </section>
  );
}
