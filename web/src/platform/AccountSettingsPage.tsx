import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, KeyRound, Loader2, ShieldCheck, UserRound } from 'lucide-react';
import type { AccountSession, PlatformUser } from '../../../shared/platform';
import { Avatar } from '../components/Avatar';
import { AccountShell } from './AccountPages';
import { platformApi, PlatformApiError } from './platformApi';
import { passwordProblem, submitPasswordChange, type MutationGate } from './accountActions';
import { AccountDevices } from './AccountDevices';
import './Platform.css';
import './AccountSettings.css';

type Outcome = 'changed' | 'unknown' | null;
export function AccountSettingsPage() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const running = useRef(false),
    sequence = useRef(0),
    completed = useRef(false);
  async function check() {
    if (running.current || completed.current) return;
    const request = ++sequence.current;
    try {
      const value = await platformApi<AccountSession>('/account/session');
      if (request !== sequence.current) return;
      setSession(value);
      setError('');
    } catch (cause) {
      if (request === sequence.current) setError((cause as Error).message);
    }
  }
  useEffect(() => {
    void check();
    const expired = () => {
      if (running.current || completed.current) return;
      sequence.current++;
      setSession({ authenticated: false, workspaces: [] });
    };
    const visible = () => {
      if (!document.hidden) void check();
    };
    window.addEventListener('openbot:account-expired', expired);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(visible, 30000);
    return () => {
      sequence.current++;
      clearInterval(timer);
      window.removeEventListener('openbot:account-expired', expired);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  const gate: MutationGate = {
    busy,
    begin: () => {
      if (running.current || completed.current) return false;
      running.current = true;
      sequence.current++;
      setBusy(true);
      return true;
    },
    finish: () => {
      running.current = false;
      setBusy(false);
    },
  };
  if (outcome) return <PasswordChangeResult outcome={outcome} />;
  if (!session?.authenticated || !session.user)
    return (
      <AccountShell
        title={uiText('account:text_5ce662ac8d87')}
        subtitle={
          session ? uiText('account:text_94f56772ad11') : uiText('account:text_c56829fdfcf9')
        }
      >
        {error && (
          <p className="platform-error" role="alert">
            {error}
          </p>
        )}
        {!session ? (
          <button
            className="secondary-button platform-full-button"
            type="button"
            onClick={() => void check()}
          >
            {error ? uiText('account:text_df7392cc96be') : <Loader2 size={18} className="spin" />}
          </button>
        ) : (
          <a className="primary-button platform-full-button" href="/login?next=%2Faccount">
            {uiText('account:text_d9a999a7c8e8')}
          </a>
        )}
      </AccountShell>
    );
  return (
    <main className="platform-team-page account-settings-page">
      <header className="platform-team-header">
        <a
          className="platform-brand"
          href="/"
          aria-disabled={busy}
          onClick={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <Avatar size={33} />
          <span>MosoCrew</span>
        </a>
        <span className="account-settings-identity">{session.user.email}</span>
      </header>
      <section className="platform-team-content account-settings-content">
        <a
          className="platform-back"
          href="/"
          aria-disabled={busy}
          onClick={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <ArrowLeft size={15} />
          {uiText('account:text_0a7576b364ac')}
        </a>
        <div className="platform-page-heading">
          <div>
            <h1>{uiText('account:text_5ce662ac8d87')}</h1>
            <p>{uiText('account:text_47d5e326a5d3')}</p>
          </div>
        </div>
        {error && (
          <p className="platform-error" role="alert">
            {error}
            <button
              type="button"
              className="platform-text-button"
              disabled={busy}
              onClick={() => void check()}
            >
              {uiText('account:text_df7392cc96be')}
            </button>
          </p>
        )}
        <AccountSettingsForms
          key={session.user.id}
          user={session.user}
          gate={gate}
          onProfile={(next) => {
            sequence.current++;
            setSession(next);
          }}
          onRevalidate={() => {
            gate.finish();
            void check();
          }}
          onPassword={(result) => {
            completed.current = true;
            sequence.current++;
            setOutcome(result);
          }}
        />
        <AccountDevices
          key={`devices:${session.user.id}`}
          userId={session.user.id}
          gate={gate}
          onIdentityChanged={() => queueMicrotask(() => void check())}
          onExpired={() => setSession({ authenticated: false, workspaces: [] })}
        />
      </section>
    </main>
  );
}

export function PasswordChangeResult({ outcome }: { outcome: 'changed' | 'unknown' }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const running = useRef(false);
  return (
    <AccountShell
      title={
        outcome === 'changed'
          ? uiText('account:text_326400c784eb')
          : uiText('account:text_7c241b5f20e0')
      }
      subtitle={
        outcome === 'changed'
          ? uiText('account:text_8ffdffbe0476')
          : uiText('account:text_b0ed89f0b4c5')
      }
    >
      {error && (
        <p className="platform-error" role="alert">
          {error}
        </p>
      )}
      {outcome === 'changed' ? (
        <a className="primary-button platform-full-button" href="/login?next=%2Faccount">
          {uiText('account:text_99232cddba71')}
        </a>
      ) : (
        <button
          type="button"
          className="primary-button platform-full-button"
          disabled={busy}
          onClick={async () => {
            if (running.current) return;
            running.current = true;
            setBusy(true);
            setError('');
            const controller = new AbortController(),
              timeout = setTimeout(() => controller.abort(), 15000);
            try {
              await platformApi('/account/logout', 'POST', undefined, {
                signal: controller.signal,
              });
              window.location.assign('/login?next=%2Faccount');
            } catch (cause) {
              setError((cause as Error).message);
            } finally {
              clearTimeout(timeout);
              running.current = false;
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 size={15} className="spin" />}
          {uiText('account:text_594bdca2cfe2')}
        </button>
      )}
    </AccountShell>
  );
}

export function AccountSettingsForms({
  user,
  gate,
  onProfile,
  onPassword,
  onRevalidate,
}: {
  user: PlatformUser;
  gate: MutationGate;
  onProfile: (session: AccountSession) => void;
  onPassword: (result: 'changed' | 'unknown') => void;
  onRevalidate: () => void;
}) {
  const [name, setName] = useState(user.name),
    [profileError, setProfileError] = useState(''),
    [saved, setSaved] = useState(false);
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const [passwordError, setPasswordError] = useState(''),
    [saving, setSaving] = useState<'profile' | 'password' | null>(null);
  const previousName = useRef(user.name),
    profileFeedback = useRef<HTMLParagraphElement>(null),
    passwordFeedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const previous = previousName.current;
    previousName.current = user.name;
    setName((value) => (value === previous ? user.name : value));
  }, [user.name]);
  useEffect(() => {
    if (profileError) profileFeedback.current?.focus();
  }, [profileError]);
  useEffect(() => {
    if (passwordError) passwordFeedback.current?.focus();
  }, [passwordError]);
  return (
    <>
      <section className="platform-section" aria-labelledby="account-profile-heading">
        <div className="platform-section-heading">
          <div>
            <h2 id="account-profile-heading">{uiText('account:text_640803d89773')}</h2>
            <p>{uiText('account:text_8e9136891c0b')}</p>
          </div>
          <UserRound size={19} />
        </div>
        <form
          className="dialog-form account-settings-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!gate.begin()) return;
            setSaving('profile');
            setProfileError('');
            setSaved(false);
            const controller = new AbortController(),
              timeout = setTimeout(() => controller.abort(), 30000);
            try {
              const result = await platformApi<AccountSession>(
                '/account/profile',
                'PATCH',
                { name: name.trim(), expectedUserId: user.id },
                { signal: controller.signal },
              );
              onProfile(result);
              setName(result.user?.name || name.trim());
              setSaved(true);
            } catch (cause) {
              setProfileError(
                controller.signal.aborted
                  ? uiText('account:text_63004088ad8f')
                  : (cause as Error).message,
              );
              if (cause instanceof PlatformApiError && [401, 409].includes(cause.status))
                onRevalidate();
            } finally {
              clearTimeout(timeout);
              setSaving(null);
              gate.finish();
            }
          }}
        >
          <label>
            {uiText('account:text_a9eaab0fd837')}
            <input value={user.email} readOnly autoComplete="username" />
          </label>
          <label>
            {uiText('account:text_50b5b1d2abef')}
            <input
              required
              maxLength={60}
              autoComplete="name"
              value={name}
              disabled={gate.busy}
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          {profileError && (
            <p className="platform-error" role="alert" tabIndex={-1} ref={profileFeedback}>
              {profileError}
              <button
                className="platform-text-button"
                type="button"
                disabled={gate.busy}
                onClick={onRevalidate}
              >
                {uiText('account:text_9b2ce4cb1c81')}
              </button>
            </p>
          )}
          {saved && (
            <p className="account-settings-saved" role="status">
              <Check size={15} />
              {uiText('account:text_24c23eeb0ee4')}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="primary-button"
              disabled={gate.busy || !name.trim() || name.trim() === user.name}
            >
              {saving === 'profile' && <Loader2 size={15} className="spin" />}
              {uiText('account:text_3f69d12fd355')}
            </button>
          </div>
        </form>
      </section>
      <section className="platform-section" aria-labelledby="account-password-heading">
        <div className="platform-section-heading">
          <div>
            <h2 id="account-password-heading">{uiText('account:text_08d008062411')}</h2>
            <p>{uiText('account:text_742a35dfcd40')}</p>
          </div>
          <KeyRound size={19} />
        </div>
        <form
          className="dialog-form account-settings-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const problem = passwordProblem(current, next, confirmation);
            if (problem) {
              setPasswordError(problem);
              return;
            }
            if (!gate.begin()) return;
            setSaving('password');
            setPasswordError('');
            try {
              const result = await submitPasswordChange({
                expectedUserId: user.id,
                currentPassword: current,
                newPassword: next,
              });
              setCurrent('');
              setNext('');
              setConfirmation('');
              onPassword(result);
            } catch (cause) {
              setCurrent('');
              setNext('');
              setConfirmation('');
              setPasswordError((cause as Error).message);
              if (cause instanceof PlatformApiError && [401, 409].includes(cause.status))
                onRevalidate();
            } finally {
              setSaving(null);
              gate.finish();
            }
          }}
        >
          <input
            type="text"
            className="account-password-username"
            aria-label={uiText('account:text_a9eaab0fd837')}
            autoComplete="username"
            value={user.email}
            readOnly
            tabIndex={-1}
          />
          <label>
            {uiText('account:text_a114cfb687e6')}
            <input
              required
              type="password"
              autoComplete="current-password"
              maxLength={128}
              value={current}
              disabled={gate.busy}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </label>
          <label>
            {uiText('account:text_515e9c7cf7b2')}
            <input
              required
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
              value={next}
              disabled={gate.busy}
              onChange={(event) => setNext(event.target.value)}
              placeholder={uiText('account:text_205cc823d72b')}
            />
          </label>
          <label>
            {uiText('account:text_6fde05a916c6')}
            <input
              required
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
              value={confirmation}
              disabled={gate.busy}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          {passwordError && (
            <p className="platform-error" role="alert" tabIndex={-1} ref={passwordFeedback}>
              {passwordError}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="primary-button"
              disabled={gate.busy || !current || !next || !confirmation}
            >
              {saving === 'password' ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <ShieldCheck size={15} />
              )}
              {uiText('account:text_ada41d39dde0')}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
