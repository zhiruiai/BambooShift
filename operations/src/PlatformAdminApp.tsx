import { uiText } from '../../web/src/i18n/account';
import { Loader2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { OperatorSession } from '../../shared/platform';
import { LoadBoundary } from '../../web/src/components/LoadBoundary';
import { AccountShell } from '../../web/src/platform/account/AccountShell';
import { platformApi } from '../../web/src/platform/platformApi';

const OperatorWorkspace = lazy(() => import('./workspace/OperatorWorkspace'));

export function PlatformAdminApp({ onSignIn }: { onSignIn: (session: OperatorSession) => void }) {
  const [session, setSession] = useState<OperatorSession | null>(null),
    [error, setError] = useState(''),
    [checking, setChecking] = useState(true);
  const sequence = useRef(0),
    lastCheck = useRef(0);
  async function check() {
    const request = ++sequence.current;
    lastCheck.current = Date.now();
    setChecking(true);
    try {
      const result = await platformApi<OperatorSession>('/platform/session');
      if (request !== sequence.current) return;
      setSession(result);
      setError('');
      if (!result.authenticated) onSignIn(result);
    } catch (cause) {
      if (request === sequence.current) setError((cause as Error).message);
    } finally {
      if (request === sequence.current) setChecking(false);
    }
  }
  useEffect(() => {
    void check();
    const expired = () => {
      sequence.current++;
      setSession({ authenticated: false, setupRequired: false });
      window.location.replace('/admin/login');
    };
    const focus = () => {
      if (!document.hidden && Date.now() - lastCheck.current > 5000) void check();
    };
    window.addEventListener('openbot:operator-expired', expired);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      sequence.current++;
      window.removeEventListener('openbot:operator-expired', expired);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, []);
  if (!session?.authenticated)
    return (
      <AccountShell
        operator
        title={uiText('platform:text_16fc3f7a97fe')}
        subtitle={uiText('platform:text_3b2b85441a1a')}
      >
        {checking ? (
          <div className="platform-loading">
            <Loader2 className="spin" size={20} />
          </div>
        ) : (
          <>
            <p className="platform-error" role="alert">
              {error || uiText('platform:text_b0211e3d6d23')}
            </p>
            <button
              className="secondary-button platform-full-button"
              type="button"
              onClick={() => void check()}
            >
              {uiText('platform:text_c25fb86b1e96')}
            </button>
            <a className="platform-operator-link" href="/admin/login">
              {uiText('platform:text_5d35049b01d6')}
            </a>
          </>
        )}
      </AccountShell>
    );
  return (
    <LoadBoundary>
      <Suspense
        fallback={
          <AccountShell operator title={uiText('platform:text_16fc3f7a97fe')}>
            <p className="platform-loading" role="status">
              {uiText('platform:text_09ed1b8b31d4')}
            </p>
          </AccountShell>
        }
      >
        <OperatorWorkspace key={session.user?.id} session={session} sessionError={error} />
      </Suspense>
    </LoadBoundary>
  );
}
