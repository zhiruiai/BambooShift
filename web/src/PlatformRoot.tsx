import { uiText } from './i18n';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { AccountSession } from '../../shared/platform';
import { parseBotTemplatePath } from '../../shared/bot-templates';
import { parseSharedBotPath } from '../../shared/shared-bots';
import { parseTeamSkillLinkPath } from '../../shared/team-skills';
import { parseWebsiteSharePath } from '../../shared/website-shares';
import { AccountContext } from './AccountContext';
import { parseAppAuthorizationPath } from './appOAuth';
import { Avatar } from './components/Avatar';
import {
  AccountPage,
  AccountShell,
  InvitationPage,
  TeamPage,
  WorkspaceChooser,
  platformApi,
} from './platform';

const ChatApp = lazy(() => import('./App'));
const BotTemplatePage = lazy(() =>
  import('./platform/BotTemplatePage').then((module) => ({ default: module.BotTemplatePage })),
);
const SharedBotPage = lazy(() =>
  import('./platform/SharedBotPage').then((module) => ({ default: module.SharedBotPage })),
);
const WorkspaceAdmin = lazy(() => import('./admin/AdminApp'));
const SharedWebsitePage = lazy(() => import('./platform/SharedWebsitePage'));
const TeamSkillLinkPage = lazy(() => import('./platform/TeamSkillLinkPage'));
const AppAuthorize = lazy(() =>
  import('./platform/AppAuthorizePage').then((module) => ({ default: module.AppAuthorizePage })),
);
const AccountSettings = lazy(() =>
  import('./platform/AccountSettingsPage').then((module) => ({
    default: module.AccountSettingsPage,
  })),
);

export default function PlatformRoot() {
  const path = window.location.pathname;
  if (path === '/team-skills' || path.startsWith('/team-skills/'))
    return (
      <Suspense
        fallback={
          <main className="loading-screen">
            <p>{uiText('common:loading')}</p>
          </main>
        }
      >
        <TeamSkillLinkPage
          link={parseTeamSkillLinkPath(window.location.href.slice(window.location.origin.length))}
        />
      </Suspense>
    );
  if (path.startsWith('/pages/')) return <SharedWebsitePage token={parseWebsiteSharePath(path)} />;
  if (path.startsWith('/shared-bots/'))
    return (
      <Suspense
        fallback={
          <main className="loading-screen">
            <p>{uiText('common:text_745d9c8b3596')}</p>
          </main>
        }
      >
        <SharedBotPage shareId={parseSharedBotPath(path)} />
      </Suspense>
    );
  const template = parseBotTemplatePath(path);
  if (template || path.startsWith('/templates/'))
    return (
      <Suspense
        fallback={
          <main className="loading-screen">
            <p>{uiText('common:text_fc9786e96c35')}</p>
          </main>
        }
      >
        <BotTemplatePage token={template} />
      </Suspense>
    );
  const authorization = parseAppAuthorizationPath(path);
  if (authorization)
    return (
      <Suspense
        fallback={
          <main className="loading-screen">
            <p>{uiText('common:text_45cde065fddd')}</p>
          </main>
        }
      >
        <AppAuthorize {...authorization} />
      </Suspense>
    );
  if (path === '/account')
    return (
      <Suspense
        fallback={
          <main className="loading-screen">
            <p>{uiText('common:text_1e55666a9920')}</p>
          </main>
        }
      >
        <AccountSettings />
      </Suspense>
    );
  const invite = /^\/invite\/([\w-]+)\/?$/.exec(path);
  if (invite) return <InvitationPage token={invite[1]} />;
  if (path === '/login' || path === '/register')
    return (
      <AccountPage
        mode={path === '/register' ? 'register' : 'login'}
        next={new URLSearchParams(window.location.search).get('next') || undefined}
      />
    );
  const workspace = /^\/w\/([a-f0-9-]{36})(?:\/(manage|members))?\/?$/.exec(path);
  return <AccountWorkspace workspaceId={workspace?.[1]} panel={workspace?.[2]} />;
}
function AccountWorkspace({ workspaceId, panel }: { workspaceId?: string; panel?: string }) {
  const [session, setSession] = useState<AccountSession | null>(null),
    [error, setError] = useState('');
  const request = useRef(0);
  const refresh = async () => {
    const current = ++request.current;
    try {
      const value = await platformApi<AccountSession>('/account/session');
      if (request.current !== current) return;
      setSession(value);
      setError('');
      if (!value.authenticated)
        window.location.replace(
          '/login' +
            (workspaceId
              ? `?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
              : ''),
        );
    } catch (cause) {
      if (request.current === current) setError((cause as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    const expired = () => {
      request.current++;
      setSession({ authenticated: false, workspaces: [] });
      window.location.replace('/login');
    };
    const revalidate = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener('openbot:account-expired', expired);
    window.addEventListener('focus', revalidate);
    window.addEventListener('openbot:revalidate', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    const heartbeat = setInterval(revalidate, 30000);
    return () => {
      request.current++;
      clearInterval(heartbeat);
      window.removeEventListener('openbot:account-expired', expired);
      window.removeEventListener('focus', revalidate);
      window.removeEventListener('openbot:revalidate', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, []);
  if (!session?.authenticated)
    return (
      <main className="loading-screen">
        <Avatar size={56} />
        <p>{error || uiText('common:text_cad787054ece')}</p>
        {error && (
          <button className="secondary-button" onClick={() => void refresh()}>
            {uiText('common:text_b8784c8dd563')}
          </button>
        )}
      </main>
    );
  const workspace = session.workspaces.find((w) => w.id === workspaceId && w.status === 'active');
  if (!workspace)
    return (
      <AccountShell
        title={uiText('common:text_56ca721193c9')}
        subtitle={
          workspaceId ? uiText('common:text_814785d6e250') : uiText('common:text_dceb17aa477c')
        }
      >
        <WorkspaceChooser session={session} onSessionChange={setSession} />
      </AccountShell>
    );
  const content =
    panel === 'members' ? (
      <TeamPage workspaceId={workspace.id} session={session} />
    ) : panel === 'manage' ? (
      workspace.role === 'owner' ? (
        <WorkspaceAdmin />
      ) : (
        <main className="loading-screen">
          <p>{uiText('common:text_b728aaa20990')}</p>
          <a href={`/w/${workspace.id}`}>{uiText('common:text_5b8ac6b1b52e')}</a>
        </main>
      )
    ) : (
      <ChatApp />
    );
  return (
    <AccountContext.Provider
      value={{ session, workspace }}
      key={`${session.user?.id}:${workspace.id}`}
    >
      <Suspense
        fallback={
          <main className="loading-screen">
            <p>{uiText('common:text_63e931a7a59c')}</p>
          </main>
        }
      >
        {content}
      </Suspense>
    </AccountContext.Provider>
  );
}
