import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, LibraryBig, RefreshCw } from 'lucide-react';
import { isSharedBot } from '../../../shared/shared-bots';
import type { TeamSkillPublication, TeamSkillTargetWorkspace } from '../../../shared/team-skills';
import type { BotAgent, Skill } from '../../../shared/types';
import { ApiError } from '../api';
import { uiText } from '../i18n';
import { Markdown } from './Markdown';
import { TeamSkillCopyLink } from './TeamSkillCopyLink';

export interface TeamSkillsAccess {
  workspaceId?: string;
  agents: BotAgent[];
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  onImported(agentId: string): void;
}

type Review =
  | { kind: 'publish'; skill: Skill; prior?: TeamSkillPublication }
  | { kind: 'withdraw'; item: TeamSkillPublication };

function errorText(cause: unknown) {
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case 'TEAM_SKILL_REVISION':
        return uiText('common:teamSkillRevision');
      case 'TEAM_SKILL_SOURCE_REQUIRED':
        return uiText('common:teamSkillSourceRequired');
      case 'TEAM_SKILL_CAPACITY':
        return uiText('common:teamSkillCapacity');
      case 'TEAM_SKILL_PERSONAL_TARGET':
        return uiText('common:teamSkillPersonalTarget');
      case 'TEAM_SKILL_TEMPLATE_SOURCE':
        return uiText('common:teamSkillTemplateSource');
    }
  }
  return cause instanceof Error ? cause.message : uiText('common:text_072387ead00b');
}

const mayWithdraw = (item: TeamSkillPublication, readOnly: boolean) =>
  item.canWithdraw ?? !readOnly;

export function TeamSkillsView({
  access,
  skills,
  readOnly,
  onBack,
}: {
  access: TeamSkillsAccess;
  skills: Skill[];
  readOnly: boolean;
  onBack: () => void;
}) {
  const [items, setItems] = useState<TeamSkillPublication[]>();
  const [personalWorkspaces, setPersonalWorkspaces] = useState<TeamSkillTargetWorkspace[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [target, setTarget] = useState('');
  const [review, setReview] = useState<Review>();
  const operation = useRef(0);
  const active = useRef(false);
  const running = useRef(false);
  const latest = useRef({ access, skills, readOnly });
  latest.current = { access, skills, readOnly };
  const agents = access.agents.filter((agent) => !isSharedBot(agent));
  const personalOptions = personalWorkspaces.flatMap((workspace) =>
    workspace.agents.map((agent) => ({
      key: `${workspace.workspaceId}/${agent.id}`,
      agent,
      workspace,
    })),
  );
  const source = skills.filter(
    (skill) =>
      skill.status === 'active' &&
      !skill.teamSource &&
      !!skill.description?.trim() &&
      agents.some((agent) => agent.id === skill.agentId),
  );
  async function work(run: (stillCurrent: () => boolean) => Promise<void>) {
    if (!active.current || running.current) return;
    running.current = true;
    const id = ++operation.current;
    const stillCurrent = () => active.current && id === operation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run(stillCurrent);
    } catch (cause) {
      if (stillCurrent()) setError(errorText(cause));
    } finally {
      if (stillCurrent()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  const refresh = () =>
    work(async (current) => {
      const { request } = latest.current.access;
      const catalog = await request<TeamSkillPublication[]>('/team-skills');
      if (current()) setItems(catalog);
      const workspaces = await request<TeamSkillTargetWorkspace[]>('/team-skills/import-targets');
      if (current()) setPersonalWorkspaces(workspaces);
    });
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      running.current = false;
      operation.current++;
    };
  }, []);

  function apply(value: Review) {
    if (
      value.kind === 'publish'
        ? latest.current.readOnly
        : !mayWithdraw(value.item, latest.current.readOnly)
    )
      return;
    if (
      value.kind === 'publish' &&
      !latest.current.skills.some(
        (skill) => skill.id === value.skill.id && skill.status === 'active' && !skill.teamSource,
      )
    ) {
      setReview(undefined);
      setError(uiText('common:teamSkillSourceRequired'));
      return;
    }
    void work(async (current) => {
      const { request } = latest.current.access;
      if (value.kind === 'publish') {
        const item = await request<TeamSkillPublication>('/team-skills', 'POST', {
          skillId: value.skill.id,
          expectedRevision: value.prior?.revision ?? null,
        });
        if (current())
          setItems((list) => [item, ...(list || []).filter((old) => old.id !== item.id)]);
      } else {
        await request(`/team-skills/${encodeURIComponent(value.item.id)}/unpublish`, 'POST', {
          expectedRevision: value.item.revision,
        });
        if (current()) setItems((list) => list?.filter((old) => old.id !== value.item.id));
      }
      if (current()) setReview(undefined);
    });
  }

  function importTarget(item: TeamSkillPublication) {
    const personal = personalOptions.find((option) => option.key === target);
    if (personal) return { agentId: personal.agent.id, personal };
    const teamAgent = latest.current.access.agents.find(
      (agent) => agent.id === target && !isSharedBot(agent),
    );
    if (
      teamAgent &&
      !latest.current.readOnly &&
      (item.source.origin === 'personal' || teamAgent.id !== item.source.agentId)
    )
      return { agentId: teamAgent.id };
  }

  function importSkill(item: TeamSkillPublication) {
    const destination = importTarget(item);
    if (!destination) return;
    const { agentId, personal } = destination;
    void work(async (current) => {
      const skill = await latest.current.access.request<Skill>(
        `/team-skills/${encodeURIComponent(item.id)}/import`,
        'POST',
        {
          agentId,
          expectedRevision: item.revision,
          ...(personal ? { targetWorkspaceId: personal.workspace.workspaceId } : {}),
        },
      );
      if (!current()) return;
      if (
        skill.agentId !== agentId ||
        skill.teamSource?.id !== item.id ||
        skill.teamSource.revision !== item.revision
      )
        throw new Error(uiText('common:text_072387ead00b'));
      if (personal) {
        setNotice(
          uiText('common:teamSkillPersonalImported', {
            bot: personal.agent.name,
            workspace: personal.workspace.workspaceName,
          }),
        );
      } else {
        latest.current.access.onImported(agentId);
      }
    });
  }

  return (
    <section className="team-skills" aria-label={uiText('common:teamSkillTitle')} aria-busy={busy}>
      <div className="team-skill-toolbar">
        <button className="secondary-button" type="button" disabled={busy} onClick={onBack}>
          <ArrowLeft size={15} aria-hidden="true" /> {uiText('common:back')}
        </button>
        <h3>
          <LibraryBig size={17} aria-hidden="true" /> {uiText('common:teamSkillTitle')}
        </h3>
        <button
          className="secondary-button"
          type="button"
          disabled={busy || !!review}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} aria-hidden="true" /> {uiText('common:refresh')}
        </button>
      </div>
      <p className="field-help">{uiText('common:teamSkillHelp')}</p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {review ? (
        <div className="dialog-form bordered-form">
          <h4>{review.kind === 'publish' ? review.skill.name : review.item.name}</h4>
          <p className="field-help">
            {uiText(
              review.kind === 'publish'
                ? 'common:teamSkillPublishHelp'
                : review.item.canModerate
                  ? 'common:teamSkillModerateHelp'
                  : 'common:teamSkillWithdrawHelp',
            )}
          </p>
          {review.kind === 'publish' && (
            <>
              <p>{review.skill.description}</p>
              <div className="skill-content team-skill-preview">
                <Markdown text={review.skill.content} />
              </div>
            </>
          )}
          <div className="team-skill-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setReview(undefined)}
            >
              {uiText('common:cancel')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={
                busy || (review.kind === 'publish' ? readOnly : !mayWithdraw(review.item, readOnly))
              }
              onClick={() => apply(review)}
            >
              {uiText(
                review.kind === 'withdraw'
                  ? review.item.canModerate
                    ? 'common:teamSkillModerate'
                    : 'common:teamSkillWithdraw'
                  : review.prior
                    ? 'common:teamSkillSync'
                    : 'common:teamSkillPublish',
              )}
            </button>
          </div>
        </div>
      ) : (
        <>
          {((!readOnly && !!agents.length) || !!personalOptions.length) && (
            <label className="dialog-form team-skill-target">
              {uiText('common:teamSkillTarget')}
              <select
                value={target}
                disabled={busy}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">{uiText('common:teamSkillChoose')}</option>
                {!readOnly && !!agents.length && (
                  <optgroup label={uiText('common:teamSkillCurrentTeam')}>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {personalWorkspaces
                  .filter((workspace) => workspace.agents.length)
                  .map((workspace) => (
                    <optgroup
                      key={workspace.workspaceId}
                      label={uiText('common:teamSkillPersonalGroup', {
                        workspace: workspace.workspaceName,
                      })}
                    >
                      {personalOptions
                        .filter((option) => option.workspace === workspace)
                        .map(({ agent, key }) => (
                          <option key={key} value={key}>
                            {agent.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
              </select>
            </label>
          )}
          {items?.length === 0 && <p className="field-help">{uiText('common:teamSkillEmpty')}</p>}
          <div className="skill-list">
            {items?.map((item) => (
              <details key={item.id} className="skill-card team-skill-item">
                <summary>
                  <strong>{item.name}</strong> · v{item.version} ·{' '}
                  {item.source.origin === 'personal'
                    ? uiText('apps:privateSkillPublicationOrigin')
                    : item.source.agentName}
                </summary>
                <p>{item.description}</p>
                <div className="skill-content team-skill-preview">
                  <Markdown text={item.content} />
                </div>
                <div className="team-skill-actions">
                  {(!readOnly || !!personalOptions.length) && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || !importTarget(item)}
                      onClick={() => importSkill(item)}
                    >
                      {uiText('common:teamSkillImport')}
                    </button>
                  )}
                  {access.workspaceId && (
                    <TeamSkillCopyLink
                      key={item.linkId}
                      teamId={access.workspaceId}
                      publicationId={item.id}
                      linkId={item.linkId}
                      disabled={busy}
                    />
                  )}
                  {mayWithdraw(item, readOnly) && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => setReview({ kind: 'withdraw', item })}
                    >
                      {uiText(
                        item.canModerate ? 'common:teamSkillModerate' : 'common:teamSkillWithdraw',
                      )}
                    </button>
                  )}
                </div>
              </details>
            ))}
          </div>
          {!readOnly && items && source.length > 0 && (
            <div className="team-skill-sources">
              <h4>{uiText('common:teamSkillSources')}</h4>
              {source.map((skill) => {
                const prior = items.find(
                  (item) =>
                    item.source.origin !== 'personal' &&
                    item.source.agentId === skill.agentId &&
                    item.name === skill.name,
                );
                const alreadyPublished =
                  prior?.source.origin !== 'personal' && prior?.source.skillId === skill.id;
                return (
                  <div className="team-skill-toolbar" key={skill.id}>
                    <span>
                      {skill.name} · v{skill.version}
                    </span>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || alreadyPublished}
                      onClick={() => setReview({ kind: 'publish', skill, prior })}
                    >
                      {uiText(
                        alreadyPublished
                          ? 'common:teamSkillPublished'
                          : prior
                            ? 'common:teamSkillSync'
                            : 'common:teamSkillPublish',
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
