import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, RefreshCw, Users } from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { SharedBotsDialog } from '../components/SharedBotsDialog';
import { AccountMenu } from './AccountAccess';
import { accountEntryPath } from './platformApi';
import {
  createSharedBotPageReader,
  sharedBotConversationPath,
  sharedBotPersonalTargets,
  type SharedBotPageState,
} from './sharedBotPageState';
import './Platform.css';
import './BotTemplatePage.css';

export function SharedBotPage({ shareId }: { shareId?: string }) {
  return shareId ? (
    <SharedBotLink key={shareId} shareId={shareId} />
  ) : (
    <main className="loading-screen">
      <Avatar size={48} />
      <h1>{uiText('account:text_39a71c80cdd2')}</h1>
      <p>{uiText('account:text_1bbb3fb5d5b1')}</p>
      <a href="/">{uiText('account:text_993fbcd2bb64')}</a>
    </main>
  );
}

function SharedBotLink({ shareId }: { shareId: string }) {
  const path = `/shared-bots/${shareId}`;
  const [state, setState] = useState<SharedBotPageState>({ loading: true, error: '' });
  const [selection, setSelection] = useState<{ userId: string; workspaceId: string }>();
  const [opening, setOpening] = useState(false);
  const [reader] = useState(() =>
    createSharedBotPageReader({
      current: () => window.location.pathname === path,
      onChange: setState,
    }),
  );
  const targets = sharedBotPersonalTargets(state.session);
  const userId = state.session?.authenticated ? state.session.user?.id : undefined;
  const selected =
    selection?.userId === userId
      ? targets.find((workspace) => workspace.id === selection?.workspaceId)
      : undefined;
  const identity = useRef({ userId, workspaceId: selected?.id, shareId });
  identity.current = { userId, workspaceId: selected?.id, shareId };
  useEffect(() => {
    reader.resume();
    void reader.read();
    const refresh = () => {
      if (!document.hidden) void reader.read();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('openbot:account-expired', refresh);
    window.addEventListener('openbot:revalidate', refresh);
    document.addEventListener('visibilitychange', refresh);
    const heartbeat = setInterval(refresh, 30_000);
    return () => {
      reader.suspend();
      clearInterval(heartbeat);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('openbot:account-expired', refresh);
      window.removeEventListener('openbot:revalidate', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reader]);
  useEffect(() => {
    setOpening(false);
  }, [userId, selected?.id]);
  return (
    <main className="platform-team-page template-public-page">
      <header className="platform-team-header">
        <a className="platform-brand" href="/">
          <Avatar size={32} />
          <span>BambooShift</span>
        </a>
        {state.session?.authenticated ? (
          <AccountMenu session={state.session} />
        ) : (
          <a className="secondary-button" href={accountEntryPath('login', path)}>
            {uiText('account:text_1e2df9c3075a')}
          </a>
        )}
      </header>
      <div className="template-public-content">
        <div className="platform-page-heading">
          <div>
            <span className="template-eyebrow">{uiText('account:text_2ac704078624')}</span>
            <h1>{uiText('account:text_5db4e79e5d54')}</h1>
            <p>{uiText('account:text_eb61310770d7')}</p>
          </div>
          <button
            className="secondary-button"
            disabled={state.loading}
            onClick={() => void reader.read()}
          >
            <RefreshCw size={15} className={state.loading ? 'spin' : ''} />
            {uiText('account:text_df7392cc96be')}
          </button>
        </div>
        {state.error && (
          <p className="platform-error" role="alert">
            {state.error}
          </p>
        )}
        {state.loading && (
          <p className="platform-help" role="status">
            {uiText('account:text_d656e9386967')}
          </p>
        )}
        <div className="template-public-layout">
          <section className="template-public-preview">
            <Users size={28} aria-hidden="true" />
            <h2>{uiText('account:text_539a7281df20')}</h2>
            <p className="platform-help">{uiText('account:text_605d609714a2')}</p>
            <p className="platform-help">{uiText('account:text_e4b244490d4f')}</p>
          </section>
          <aside className="template-public-import">
            {userId ? (
              <>
                <h2>{uiText('account:text_94337477f03a')}</h2>
                {targets.length ? (
                  <>
                    <label className="dialog-form">
                      {uiText('account:text_17de15028b1f')}
                      <select
                        value={selected?.id || ''}
                        disabled={state.loading}
                        onChange={(event) =>
                          setSelection({ userId, workspaceId: event.target.value })
                        }
                      >
                        <option value="" disabled>
                          {uiText('account:text_62c89b0b1dd7')}
                        </option>
                        {targets.map((workspace) => (
                          <option key={workspace.id} value={workspace.id}>
                            {workspace.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p>{uiText('account:text_6700ef5dae70')}</p>
                    <button
                      className="primary-button platform-full-button"
                      disabled={!selected || state.loading}
                      onClick={() => setOpening(true)}
                    >
                      {uiText('account:text_3e601459ec39')}
                      <ArrowRight size={15} />
                    </button>
                  </>
                ) : (
                  <>
                    <p>{uiText('account:text_fbf9ff887abe')}</p>
                    <a href="/">{uiText('account:text_45bf8c4e8be0')}</a>
                  </>
                )}
              </>
            ) : (
              <>
                <h2>{uiText('account:text_9a73bf07c9ed')}</h2>
                <p>{uiText('account:text_53c0c35d92e1')}</p>
                <a
                  className="primary-button platform-full-button"
                  href={accountEntryPath('login', path)}
                >
                  {uiText('account:text_a4e09c4c209d')}
                  <ArrowRight size={15} />
                </a>
                <a
                  className="secondary-button platform-full-button"
                  href={accountEntryPath('register', path)}
                >
                  {uiText('account:text_679e917b16ef')}
                </a>
              </>
            )}
          </aside>
        </div>
      </div>
      {opening && userId && selected && (
        <SharedBotsDialog
          key={`${userId}:${selected.id}`}
          userId={userId}
          personalWorkspace={selected}
          shareId={shareId}
          teams={state.session!.workspaces.filter(
            (workspace) => workspace.kind === 'team' && workspace.status === 'active',
          )}
          onClose={() => setOpening(false)}
          onOpen={(confirmed) => {
            const destination = sharedBotConversationPath(confirmed, identity.current);
            if (destination && window.location.pathname === path)
              window.location.assign(destination);
          }}
        />
      )}
    </main>
  );
}
