import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, ShieldCheck } from 'lucide-react';
import type { AccountSession } from '../../../shared/platform';
import type { AppOAuthFlow } from '../../../shared/app-oauth';
import { createAppConnectionScope } from '../appConnections';
import { appAuthorizationPath, oauthPhaseLabel, validAuthorizationUrl } from '../appOAuth';
import { AccountShell } from './AccountPages';
import { accountEntryPath, platformApi } from './platformApi';
import '../components/AppsDialog.css';

export function AppAuthorizePage({
  workspaceId,
  connectionId,
  flowId,
}: {
  workspaceId: string;
  connectionId: string;
  flowId: string;
}) {
  const [session, setSession] = useState<AccountSession | null>(null),
    [error, setError] = useState('');
  const version = useRef(0);
  const path = appAuthorizationPath(workspaceId, connectionId, flowId);
  async function check() {
    const ticket = ++version.current;
    setError('');
    try {
      const result = await platformApi<AccountSession>('/account/session');
      if (version.current === ticket) setSession(result);
    } catch (cause) {
      if (version.current === ticket) setError((cause as Error).message);
    }
  }
  useEffect(() => {
    void check();
    const visible = () => {
      if (!document.hidden) void check();
    };
    window.addEventListener('focus', visible);
    window.addEventListener('openbot:account-expired', visible);
    return () => {
      version.current++;
      window.removeEventListener('focus', visible);
      window.removeEventListener('openbot:account-expired', visible);
    };
  }, [path]);
  const workspace = session?.workspaces.find(
    (item) => item.id === workspaceId && item.status === 'active' && item.role === 'owner',
  );
  return (
    <AccountShell
      title={uiText('account:text_bb8a2e4314c2')}
      subtitle={uiText('account:text_c7d0301f453c')}
    >
      {error && (
        <p className="platform-error" role="alert">
          {error}
        </p>
      )}
      {!session ? (
        <>
          <p className="platform-help">{uiText('account:text_a51656deb60c')}</p>
          {error && (
            <button type="button" className="secondary-button" onClick={() => void check()}>
              {uiText('account:text_c25fb86b1e96')}
            </button>
          )}
        </>
      ) : !session.authenticated ? (
        <a className="primary-button platform-full-button" href={accountEntryPath('login', path)}>
          {uiText('account:text_9b353d7d5e98')}
        </a>
      ) : (
        <>
          <p className="platform-help">
            {uiText('account:text_0f2ffdeb0496')}
            {session.user?.name} · {session.user?.email}
          </p>
          {workspace && session.user ? (
            <AuthorizationHandoff
              key={`${session.user.id}:${path}`}
              workspaceId={workspaceId}
              connectionId={connectionId}
              flowId={flowId}
              userId={session.user.id}
              workspaceName={workspace.name}
            />
          ) : (
            <p className="platform-error">{uiText('account:text_67a1918a9351')}</p>
          )}
          <button
            type="button"
            className="platform-text-button"
            onClick={async () => {
              const ticket = ++version.current;
              try {
                await platformApi('/account/logout', 'POST');
                if (version.current === ticket)
                  window.location.assign(accountEntryPath('login', path));
              } catch (cause) {
                if (version.current === ticket) setError((cause as Error).message);
              }
            }}
          >
            {uiText('account:text_09392a2b9b8a')}
          </button>
        </>
      )}
    </AccountShell>
  );
}
function AuthorizationHandoff({
  workspaceId,
  connectionId,
  flowId,
  userId,
  workspaceName,
}: {
  workspaceId: string;
  connectionId: string;
  flowId: string;
  userId: string;
  workspaceName: string;
}) {
  const [scope] = useState(() => createAppConnectionScope({ workspaceId, userId }));
  const [flow, setFlow] = useState<AppOAuthFlow>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [beginSent, setBeginSent] = useState(false),
    [consent, setConsent] = useState(false);
  const running = useRef(false),
    dispatched = useRef(false),
    sequence = useRef(0);
  const root = `/apps/${encodeURIComponent(connectionId)}/oauth/${encodeURIComponent(flowId)}`;
  async function read() {
    if (running.current) return;
    const ticket = scope.ticket(),
      id = ++sequence.current;
    setLoading(true);
    try {
      const value = await scope.request<AppOAuthFlow>(`${root}/handoff`);
      if (scope.current(ticket) && id === sequence.current) {
        setFlow(value);
        setError('');
      }
    } catch (cause) {
      if (scope.current(ticket) && id === sequence.current) setError((cause as Error).message);
    } finally {
      if (scope.current(ticket) && id === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    scope.resume();
    void read();
    return () => {
      scope.suspend();
      sequence.current++;
    };
  }, [scope]);
  async function begin() {
    const ticket = scope.ticket();
    if (
      !scope.current(ticket) ||
      running.current ||
      dispatched.current ||
      !consent ||
      flow?.status !== 'pending' ||
      !Number.isFinite(Date.parse(flow.expiresAt)) ||
      Date.parse(flow.expiresAt) <= Date.now()
    )
      return;
    running.current = true;
    dispatched.current = true;
    setBeginSent(true);
    sequence.current++;
    setBusy(true);
    setError('');
    try {
      const result = await scope.request<{ authorizationUrl: string }>(`${root}/begin`, 'POST', {});
      if (!scope.current(ticket)) return;
      if (!validAuthorizationUrl(result.authorizationUrl, flow.authorizationOrigin))
        throw new Error(uiText('account:text_5b2b90c10ecf'));
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) setBusy(false);
    }
  }
  return (
    <section className="apps-handoff">
      {loading && !flow ? (
        <p className="platform-help">
          <Loader2 size={16} className="spin" />
          {uiText('account:text_45cde065fddd')}
        </p>
      ) : (
        flow && (
          <>
            <h2>{flow.appName}</h2>
            <p className="platform-help">
              {uiText('account:text_5b3a32738434')}
              {workspaceName}
            </p>
            <p className="platform-help">
              {uiText('account:text_086656b9ad4b')}
              {flow.authorizationOrigin || flow.issuer || uiText('account:text_842929f768e0')}
            </p>
            {flow.scopes.length > 0 && (
              <>
                <p className="platform-help">{uiText('account:text_2b736907d5db')}</p>
                <ul>
                  {flow.scopes.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="platform-help">
              <ShieldCheck size={15} />
              {uiText('account:text_9b9b857fdd2f')}
            </p>
            {flow.status === 'pending' ? (
              <>
                <label className="apps-consent">
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={busy}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  <span>{uiText('account:text_9f310762c764')}</span>
                </label>
                <button
                  type="button"
                  className="primary-button platform-full-button"
                  disabled={busy || loading || beginSent || !consent}
                  onClick={() => void begin()}
                >
                  {busy ? <Loader2 size={15} className="spin" /> : <ExternalLink size={15} />}
                  {uiText('account:text_9349f14d79a0')}
                </button>
              </>
            ) : (
              <p className="platform-help" role="status">
                {oauthPhaseLabel(flow.status)}
                {uiText('account:text_da6c5db77ce2')}
                {flow.status === 'callback_received' ? uiText('account:text_b35475100b28') : ''}
                {uiText('common:punct_eb0d5884569b')}
              </p>
            )}
          </>
        )
      )}
      {error && (
        <p className="platform-error" role="alert">
          {error}
        </p>
      )}
      {beginSent && !busy && error && (
        <p className="platform-help">{uiText('account:text_5fd2dcf87bbe')}</p>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={busy || loading}
        onClick={() => void read()}
      >
        {uiText('account:text_90b0a90e2226')}
      </button>
    </section>
  );
}
