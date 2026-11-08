import { uiText } from '../i18n';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AccountAuthResult, AccountSession } from '../../../shared/platform';
import { WorkspaceChooser } from './AccountAccess';
import './Platform.css';
import { AccountShell } from './account/AccountShell';
import { accountEntryPath, platformApi, safeAccountNext, workspacePath } from './platformApi';
export { AccountShell } from './account/AccountShell';
export { InvitationPage } from './account/InvitationPage';
export function AccountPage({ mode, next }: { mode: 'login' | 'register'; next?: string }) {
  const destination = safeAccountNext(
    next ?? new URLSearchParams(window.location.search).get('next'),
  );
  const [session, setSession] = useState<AccountSession | null>(null),
    [checking, setChecking] = useState(true),
    [loadError, setLoadError] = useState('');
  const [email, setEmail] = useState(''),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const [kind, setKind] = useState<'personal' | 'team'>('personal'),
    [teamName, setTeamName] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef(0),
    submitting = useRef(false);
  async function check() {
    const id = ++request.current;
    setChecking(true);
    setLoadError('');
    try {
      const value = await platformApi<AccountSession>('/account/session');
      if (id === request.current) setSession(value);
    } catch (cause) {
      if (id === request.current) setLoadError((cause as Error).message);
    } finally {
      if (id === request.current) setChecking(false);
    }
  }
  useEffect(() => {
    void check();
    return () => {
      request.current++;
    };
  }, []);
  const register = mode === 'register';
  return (
    <AccountShell
      title={
        session?.authenticated
          ? uiText('account:text_bdf39358a4d0')
          : register
            ? uiText('account:text_0aa78a3dfb7a')
            : uiText('account:text_cb1d97794707')
      }
      subtitle={
        session?.authenticated
          ? uiText('account:text_e503ceba6627')
          : register
            ? uiText('account:text_f54915e982b8')
            : uiText('account:text_3059fd27213d')
      }
    >
      {checking ? (
        <div className="platform-loading">
          <Loader2 className="spin" size={20} />
          <p>{uiText('account:text_a51656deb60c')}</p>
        </div>
      ) : session?.authenticated ? (
        <>
          {destination && (
            <a className="primary-button platform-full-button" href={destination}>
              {destination.startsWith('/app-authorize/')
                ? uiText('account:text_3d177ed85368')
                : destination.startsWith('/templates/')
                  ? uiText('account:text_36eb63db9a4f')
                  : uiText('account:text_84a207ff7eee')}
              <ArrowRight size={15} />
            </a>
          )}
          <WorkspaceChooser session={session} onSessionChange={setSession} />
        </>
      ) : (
        <>
          {loadError && (
            <div className="platform-error" role="alert">
              {loadError}
              <button className="platform-text-button" type="button" onClick={() => void check()}>
                {uiText('account:text_c25fb86b1e96')}
              </button>
            </div>
          )}
          <form
            className="dialog-form platform-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (submitting.current) return;
              if (register && password !== confirmation) {
                setError(uiText('account:text_9daceebc80d0'));
                return;
              }
              submitting.current = true;
              setBusy(true);
              setError('');
              try {
                const result = await platformApi<AccountAuthResult>(
                  register ? '/account/register' : '/account/login',
                  'POST',
                  register
                    ? {
                        email: email.trim(),
                        name: name.trim(),
                        password,
                        kind,
                        ...(kind === 'team' ? { teamName: teamName.trim() } : {}),
                      }
                    : { email: email.trim(), password },
                );
                if (!result.authenticated || !result.workspaceId)
                  throw new Error(uiText('account:text_ae8e90c3fc1c'));
                setPassword('');
                setConfirmation('');
                window.location.assign(destination || workspacePath(result.workspaceId));
              } catch (cause) {
                setError((cause as Error).message);
              } finally {
                submitting.current = false;
                setBusy(false);
              }
            }}
          >
            {register && (
              <div
                className="platform-kind-picker"
                aria-label={uiText('account:text_ac5ec1acb8e3')}
              >
                <button
                  type="button"
                  aria-pressed={kind === 'personal'}
                  disabled={busy}
                  onClick={() => setKind('personal')}
                >
                  {uiText('account:text_52ab35bfb201')}
                </button>
                <button
                  type="button"
                  aria-pressed={kind === 'team'}
                  disabled={busy}
                  onClick={() => setKind('team')}
                >
                  {uiText('account:text_d2ec1c315266')}
                </button>
              </div>
            )}
            {register && (
              <label>
                {uiText('account:text_bf144f7d9f12')}
                <input
                  required
                  maxLength={60}
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  placeholder={uiText('account:text_817b61ce2da9')}
                />
              </label>
            )}
            <label>
              {uiText('account:text_73075237fd0f')}
              <input
                type="email"
                required
                maxLength={254}
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="name@example.com"
              />
            </label>
            <label>
              {uiText('account:text_a621ab606db2')}
              <input
                type="password"
                required
                minLength={10}
                maxLength={128}
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={register ? 'new-password' : 'current-password'}
              />
              {register && <small>{uiText('account:text_0fe66b842224')}</small>}
            </label>
            {register && (
              <label>
                {uiText('account:text_81b17bc0c362')}
                <input
                  type="password"
                  required
                  minLength={10}
                  maxLength={128}
                  value={confirmation}
                  disabled={busy}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
            )}
            {register && kind === 'team' && (
              <label>
                {uiText('account:text_492fd0457fc4')}
                <input
                  required
                  maxLength={80}
                  value={teamName}
                  disabled={busy}
                  onChange={(event) => setTeamName(event.target.value)}
                  autoComplete="organization"
                  placeholder={uiText('account:text_e96f04f04be0')}
                />
                <small>{uiText('account:text_bd1225ba438a')}</small>
              </label>
            )}
            {error && (
              <p className="platform-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary-button platform-full-button" disabled={busy}>
              {busy ? <Loader2 className="spin" size={16} /> : <ArrowRight size={16} />}
              {busy
                ? uiText('account:text_26ef00b7d061')
                : register
                  ? kind === 'team'
                    ? uiText('account:text_a8723037dd60')
                    : uiText('account:text_be277b0dcbbc')
                  : uiText('account:text_1e2df9c3075a')}
            </button>
          </form>
          <p className="platform-auth-switch">
            {register ? uiText('account:text_bbaffe14e0da') : uiText('account:text_23e526538b99')}
            <a href={accountEntryPath(register ? 'login' : 'register', destination)}>
              {register ? uiText('account:text_1e2df9c3075a') : uiText('account:text_c4fb62202bad')}
            </a>
          </p>
        </>
      )}
    </AccountShell>
  );
}
