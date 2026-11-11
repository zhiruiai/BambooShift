import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AccountSession } from '../../../shared/platform';
import {
  teamSkillLinkPath,
  type TeamSkillLink,
  type TeamSkillPublication,
} from '../../../shared/team-skills';
import { Avatar } from '../components/Avatar';
import { Markdown } from '../components/Markdown';
import { uiText } from '../i18n';
import { accountEntryPath, platformApi, PlatformApiError, workspacePath } from './platformApi';
import './TeamSkillLinkPage.css';

type View =
  | { status: 'loading' | 'unavailable' | 'failed' }
  | { status: 'ready'; teamName: string; skill: TeamSkillPublication };

function matchesLink(
  skill: (TeamSkillPublication & { withdrawnAt?: unknown }) | null,
  publicationId: string,
  linkId: string,
) {
  return (
    !!skill &&
    skill.id === publicationId &&
    skill.linkId === linkId &&
    skill.withdrawnAt == null &&
    typeof skill.name === 'string' &&
    typeof skill.description === 'string' &&
    typeof skill.content === 'string' &&
    Number.isSafeInteger(skill.version) &&
    skill.version >= 1 &&
    !!skill.source &&
    (skill.source.origin === 'personal' ||
      ((skill.source.origin === 'team' || skill.source.origin === undefined) &&
        typeof skill.source.agentName === 'string'))
  );
}

export default function TeamSkillLinkPage({ link }: { link?: TeamSkillLink }) {
  const path = link && teamSkillLinkPath(link.teamId, link.publicationId, link.linkId);
  return link && path ? (
    <LinkedSkill key={path} path={path} link={link} />
  ) : (
    <TeamSkillLinkLayout view={{ status: 'unavailable' }} />
  );
}

function LinkedSkill({ path, link }: { path: string; link: TeamSkillLink }) {
  const { teamId, publicationId, linkId } = link;
  const [view, setView] = useState<View>({ status: 'loading' });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const href = new URL(path, window.location.origin).href;
    const onPath = () => window.location.href === href;
    let request: AbortController | undefined;
    const retire = () => {
      request?.abort();
      request = undefined;
    };
    const suspend = () => {
      retire();
      setView({ status: 'loading' });
    };
    const expired = () => {
      suspend();
      if (onPath()) window.location.replace(accountEntryPath('login', path));
    };
    const read = async (clear: boolean) => {
      if (!onPath()) {
        retire();
        setView({ status: 'unavailable' });
        return;
      }
      if (document.hidden) return;
      retire();
      if (clear) setView({ status: 'loading' });
      const current = new AbortController();
      request = current;
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(15_000)]);
      const isCurrent = () => request === current && onPath() && !document.hidden;
      try {
        const session = await platformApi<AccountSession>('/account/session', 'GET', undefined, {
          signal,
        });
        if (!isCurrent()) return;
        if (!session.authenticated) {
          expired();
          return;
        }
        const user = session.user;
        const team = session.workspaces.find(
          (workspace) =>
            workspace.id === teamId && workspace.kind === 'team' && workspace.status === 'active',
        );
        if (!user?.id || user.status !== 'active' || !team) {
          setView({ status: 'unavailable' });
          return;
        }
        const skill = await platformApi<TeamSkillPublication>(
          `/workspaces/${teamId}/team-skills/${publicationId}/link/${linkId}`,
          'GET',
          undefined,
          { expectedUser: user.id, signal },
        );
        if (!isCurrent()) return;
        setView(
          matchesLink(skill, publicationId, linkId)
            ? { status: 'ready', teamName: team.name, skill }
            : { status: 'unavailable' },
        );
      } catch (cause) {
        if (!isCurrent()) return;
        setView({
          status:
            cause instanceof PlatformApiError && [403, 404, 410].includes(cause.status)
              ? 'unavailable'
              : 'failed',
        });
      } finally {
        if (request === current) request = undefined;
      }
    };
    const revalidate = () => void read(true);
    const visibility = () => (document.hidden ? suspend() : revalidate());
    // A cached history entry must restore without the previous account's skill text.
    const pageHide = () => flushSync(suspend);
    const pageShow = (event: PageTransitionEvent) => {
      if (event.persisted) revalidate();
    };
    window.addEventListener('openbot:account-expired', expired);
    window.addEventListener('openbot:revalidate', revalidate);
    window.addEventListener('focus', revalidate);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    window.addEventListener('popstate', revalidate);
    window.addEventListener('hashchange', revalidate);
    document.addEventListener('visibilitychange', visibility);
    revalidate();
    const heartbeat = window.setInterval(() => {
      if (!request) void read(false);
    }, 30_000);
    return () => {
      retire();
      window.clearInterval(heartbeat);
      window.removeEventListener('openbot:account-expired', expired);
      window.removeEventListener('openbot:revalidate', revalidate);
      window.removeEventListener('focus', revalidate);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
      window.removeEventListener('popstate', revalidate);
      window.removeEventListener('hashchange', revalidate);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [path, teamId, publicationId, linkId, retry]);

  return (
    <TeamSkillLinkLayout
      view={view}
      teamId={teamId}
      onRetry={() => setRetry((value) => value + 1)}
    />
  );
}

function TeamSkillLinkLayout({
  view,
  teamId,
  onRetry,
}: {
  view: View;
  teamId?: string;
  onRetry?: () => void;
}) {
  return (
    <main className="platform-team-page">
      <header className="platform-team-header">
        <a className="platform-brand" href="/">
          <Avatar size={32} />
          <span>BambooShift</span>
        </a>
      </header>
      <div className="platform-team-content team-skill-link-content">
        <div className="platform-page-heading">
          <div>
            <h1>
              {view.status === 'ready' ? view.skill.name : uiText('common:teamSkillLinkTitle')}
            </h1>
            {view.status === 'ready' && (
              <p>
                {uiText('common:teamSkillLinkVersion', {
                  team: view.teamName,
                  version: view.skill.version,
                })}
              </p>
            )}
          </div>
          {view.status === 'ready' && teamId && (
            <a className="secondary-button" href={workspacePath(teamId)}>
              {uiText('common:teamSkillLinkOpenWorkspace')}
            </a>
          )}
        </div>
        {view.status === 'loading' && <p role="status">{uiText('common:loading')}</p>}
        {view.status === 'unavailable' && (
          <p role="status">{uiText('common:teamSkillLinkUnavailable')}</p>
        )}
        {view.status === 'failed' && (
          <div className="platform-error">
            <p role="alert">{uiText('common:teamSkillLinkError')}</p>
            <button className="secondary-button" type="button" onClick={onRetry}>
              {uiText('common:refresh')}
            </button>
          </div>
        )}
        {view.status === 'ready' && (
          <article className="team-skill-link-detail">
            <p className="field-help">
              {view.skill.source.origin === 'personal'
                ? uiText('apps:privateSkillPublicationOrigin')
                : view.skill.source.agentName}
            </p>
            <p>{view.skill.description}</p>
            <div className="skill-content team-skill-link-markdown">
              <Markdown text={view.skill.content} passive />
            </div>
          </article>
        )}
      </div>
    </main>
  );
}
