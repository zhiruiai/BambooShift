import { uiText } from '../../../web/src/i18n';
import { Loader2, LogOut, Pause, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { OperatorSession, PlatformOverview } from '../../../shared/platform';
import '../../../web/src/admin/Admin.css';
import { Avatar } from '../../../web/src/components/Avatar';
import { Dialog } from '../../../web/src/components/UI';
import '../../../web/src/platform/Platform.css';
import { platformTime } from '../../../web/src/platform/platformApi';
import { useOperatorScope } from './useOperatorScope';
import { PlatformDirectory } from './PlatformDirectory';
import { PlatformOverviewPanel } from './PlatformOverviewPanel';
import { initialView } from './Status';
import { StatusTarget, View, views } from './types';
export function OperatorWorkspace({
  session,
  sessionError,
}: {
  session: OperatorSession;
  sessionError: string;
}) {
  const scope = useOperatorScope(session.user?.id);
  const [view, setView] = useState<View>(initialView),
    [overview, setOverview] = useState<PlatformOverview | null>(null),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirm, setConfirm] = useState<StatusTarget | null>(null);
  const sequence = useRef(0),
    running = useRef(false);
  async function load() {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const result = await scope.request<PlatformOverview>('/platform/overview');
      if (request === sequence.current) {
        setOverview(result);
        setLoadError('');
      }
    } catch (cause) {
      if (request === sequence.current) setLoadError((cause as Error).message);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [revision, scope]);
  useEffect(() => {
    const hash = () => setView(initialView());
    window.addEventListener('hashchange', hash);
    const title = document.title;
    document.title = uiText('platform:text_50ea1e572808');
    return () => {
      document.title = title;
      window.removeEventListener('hashchange', hash);
    };
  }, []);
  function changeView(next: View) {
    setView(next);
    window.history.replaceState(null, '', `${window.location.pathname}#${next}`);
  }
  function ask(target: StatusTarget) {
    setError('');
    setNotice('');
    setConfirm(target);
  }
  return (
    <main className="admin-shell platform-operator">
      <aside className="admin-sidebar">
        <a className="admin-brand" href="/admin">
          <Avatar size={35} />
          <span>
            <strong>PandaMate</strong>
            <small>{uiText('platform:text_e0f17eefe421')}</small>
          </span>
        </a>
        <nav className="admin-nav" aria-label={uiText('platform:text_97529a84771f')}>
          {views.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={view === item.id ? 'active' : ''}
                aria-current={view === item.id ? 'page' : undefined}
                onClick={() => changeView(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="admin-sidebar-footer">
          <strong>{session.user?.name}</strong>
          <small>{session.user?.email}</small>
          <button
            className="platform-text-button"
            type="button"
            disabled={busy}
            onClick={async () => {
              if (running.current) return;
              running.current = true;
              setBusy(true);
              setError('');
              try {
                await scope.request('/platform/logout', 'POST');
                window.location.assign('/admin/login');
              } catch (cause) {
                setError((cause as Error).message);
              } finally {
                running.current = false;
                setBusy(false);
              }
            }}
          >
            <LogOut size={15} />
            {uiText('platform:text_18e1988f6e45')}
          </button>
        </div>
      </aside>
      <section className="admin-main">
        <header className="admin-topbar">
          <div>
            <h1>{views.find((item) => item.id === view)?.label}</h1>
            <p>
              {overview
                ? uiText('platform:text_863e69c6acd6', {
                    value0: platformTime(overview.generatedAt),
                  })
                : uiText('platform:text_5cc6c047d8b5')}
            </p>
          </div>
          <div className="admin-topbar-actions">
            <span className="admin-status is-working">
              <ShieldCheck size={13} />
              {uiText('platform:text_8a1c3e502db5')}
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={busy || loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              {uiText('platform:text_aee887434131')}
            </button>
          </div>
        </header>
        <div className="admin-content">
          {sessionError && (
            <p className="platform-error" role="alert">
              {uiText('platform:text_f52c919d1247')}
              {sessionError}
            </p>
          )}
          {loadError && (
            <p className="platform-error" role="alert">
              {overview
                ? uiText('platform:text_659448214fbb')
                : uiText('platform:text_56c4c1e6bc47')}{' '}
              {loadError}
            </p>
          )}
          {error && !confirm && (
            <p className="platform-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="platform-notice" role="status">
              {notice}
            </p>
          )}
          {view === 'overview' ? (
            overview ? (
              <PlatformOverviewPanel overview={overview} onView={changeView} />
            ) : (
              <div className="platform-loading">
                {loading && <Loader2 className="spin" size={20} />}
                <p>
                  {loading
                    ? uiText('platform:text_09ed1b8b31d4')
                    : uiText('platform:text_eefdf34ce3bc')}
                </p>
              </div>
            )
          ) : (
            <PlatformDirectory
              key={view}
              kind={view}
              revision={revision}
              currentUserId={session.user?.id}
              busy={busy}
              onChangeStatus={ask}
            />
          )}
        </div>
      </section>
      {confirm && (
        <Dialog
          title={uiText(
            confirm.kind === 'users'
              ? confirm.status === 'active'
                ? 'platform:disableUser'
                : 'platform:enableUser'
              : confirm.status === 'active'
                ? 'platform:disableWorkspace'
                : 'platform:enableWorkspace',
          )}
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
          className="platform-dialog"
        >
          <p className="platform-confirm-message">
            {confirm.status === 'active'
              ? confirm.kind === 'users'
                ? uiText('platform:text_49928eb4e419', { value0: confirm.name })
                : uiText('platform:text_8dda1c92b496', { value0: confirm.name })
              : uiText('platform:text_6d32b340f35e', { value0: confirm.name })}
          </p>
          {error && (
            <p className="platform-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              {uiText('platform:text_2cd0f3be8738')}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={busy}
              onClick={async () => {
                if (running.current) return;
                running.current = true;
                setBusy(true);
                setError('');
                try {
                  await scope.request(
                    `/platform/${confirm.kind}/${encodeURIComponent(confirm.id)}`,
                    'PATCH',
                    { status: confirm.status === 'active' ? 'suspended' : 'active' },
                  );
                  setNotice(
                    uiText(
                      confirm.status === 'active'
                        ? 'platform:disabledNotice'
                        : 'platform:restoredNotice',
                      { name: confirm.name },
                    ),
                  );
                  setConfirm(null);
                  setRevision((value) => value + 1);
                } catch (cause) {
                  setError((cause as Error).message);
                } finally {
                  running.current = false;
                  setBusy(false);
                }
              }}
            >
              {busy ? (
                <Loader2 className="spin" size={14} />
              ) : confirm.status === 'active' ? (
                <Pause size={14} />
              ) : (
                <Play size={14} />
              )}
              {confirm.status === 'active'
                ? uiText('platform:text_b6c82c2d564b')
                : uiText('platform:text_51e44d56ec90')}
            </button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
