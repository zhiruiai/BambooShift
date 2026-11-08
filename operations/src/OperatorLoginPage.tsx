import { uiText } from '../../web/src/i18n';
import { ArrowRight, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { OperatorSession } from '../../shared/platform';
import '../../web/src/platform/Platform.css';
import { platformApi } from '../../web/src/platform/platformApi';
import { AccountShell } from '../../web/src/platform/account/AccountShell';
export function OperatorLoginPage({ setup = false }: { setup?: boolean }) {
  const [session, setSession] = useState<OperatorSession | null>(null),
    [loading, setLoading] = useState(true);
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [name, setName] = useState(''),
    [code, setCode] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const sequence = useRef(0),
    submitting = useRef(false);
  async function load() {
    const id = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await platformApi<OperatorSession>('/platform/session');
      if (id === sequence.current) setSession(result);
    } catch (cause) {
      if (id === sequence.current) setError((cause as Error).message);
    } finally {
      if (id === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, []);
  return (
    <AccountShell
      operator
      title={setup ? uiText('account:text_064d941a717a') : uiText('account:text_5fc9781933f5')}
      subtitle={setup ? uiText('account:text_29757c156628') : uiText('account:text_a786dd7e3441')}
    >
      {loading ? (
        <div className="platform-loading">
          <Loader2 size={20} className="spin" />
          <p>{uiText('account:text_869ab762af17')}</p>
        </div>
      ) : session?.authenticated ? (
        <>
          <p className="platform-help">
            {uiText('account:text_a8ad20a17995')}
            {session.user?.name}
            {uiText('account:text_9be7f7dd3e5d')}
          </p>
          <a className="primary-button platform-full-button" href="/admin">
            {uiText('account:text_2540c1981044')}
            <ArrowRight size={16} />
          </a>
          <button
            className="platform-text-button"
            type="button"
            disabled={busy}
            onClick={async () => {
              const ticket = sequence.current;
              setBusy(true);
              try {
                await platformApi('/platform/logout', 'POST', undefined, {
                  expectedUser: session.user?.id,
                });
                if (ticket !== sequence.current) return;
                setSession({ ...session, authenticated: false, user: undefined });
              } catch (cause) {
                setError((cause as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {uiText('account:text_18e1988f6e45')}
          </button>
        </>
      ) : !session ? (
        <button
          className="secondary-button platform-full-button"
          type="button"
          onClick={() => void load()}
        >
          {uiText('account:text_67c3864fd0b2')}
        </button>
      ) : setup !== session.setupRequired ? (
        <div className="platform-help">
          {session.setupRequired
            ? uiText('account:text_54110dde3ef3')
            : uiText('account:text_d1c4c674a03f')}
          <a
            className="secondary-button platform-full-button"
            href={session.setupRequired ? '/admin/setup' : '/admin/login'}
          >
            {session.setupRequired
              ? uiText('account:text_46ac3521770d')
              : uiText('account:text_5d35049b01d6')}
          </a>
        </div>
      ) : (
        <form
          className="dialog-form platform-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (submitting.current) return;
            submitting.current = true;
            const ticket = sequence.current;
            setBusy(true);
            setError('');
            try {
              const result = await platformApi<OperatorSession>(
                setup ? '/platform/setup' : '/platform/login',
                'POST',
                setup
                  ? { code: code.trim(), email: email.trim(), name: name.trim(), password }
                  : { email: email.trim(), password },
              );
              if (ticket !== sequence.current) return;
              if (!result.authenticated) throw new Error(uiText('account:text_aabe16ce41d6'));
              setPassword('');
              setCode('');
              window.location.assign('/admin');
            } catch (cause) {
              setError((cause as Error).message);
            } finally {
              submitting.current = false;
              setBusy(false);
            }
          }}
        >
          {setup && (
            <>
              <label>
                {uiText('account:text_c644540718cd')}
                <input
                  type="password"
                  required
                  value={code}
                  disabled={busy}
                  autoComplete="off"
                  onChange={(event) => setCode(event.target.value)}
                />
                <small>{uiText('account:text_c73b4f4b9cf2')}</small>
              </label>
              <label>
                {uiText('account:text_bf144f7d9f12')}
                <input
                  required
                  maxLength={60}
                  value={name}
                  disabled={busy}
                  autoComplete="name"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            </>
          )}
          <label>
            {uiText('account:text_73075237fd0f')}
            <input
              type="email"
              required
              maxLength={254}
              value={email}
              disabled={busy}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setEmail(event.target.value)}
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
              autoComplete={setup ? 'new-password' : 'current-password'}
              onChange={(event) => setPassword(event.target.value)}
            />
            {setup && <small>{uiText('account:text_0fe66b842224')}</small>}
          </label>
          <button className="primary-button platform-full-button" disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}
            {busy
              ? uiText('account:text_26ef00b7d061')
              : setup
                ? uiText('account:text_067c41b9878d')
                : uiText('account:text_961a3e5b142d')}
          </button>
        </form>
      )}
      {error && (
        <p className="platform-error" role="alert">
          {error}
        </p>
      )}
      <p className="platform-help">{uiText('platform:operatorOnly')}</p>
    </AccountShell>
  );
}
