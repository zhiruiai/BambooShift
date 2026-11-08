import { ArrowLeft, BookOpen, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { uiText } from '../../i18n';
import type { createAppConnectionScope } from '../../appConnections';
import { privateSkillKey, privateSkillTargets, type PrivateSkill } from '../../privateSkills';
import { usePrivateSkills } from './usePrivateSkills';
import { usePrivateSkillPublication } from './usePrivateSkillPublication';
import {
  PrivateSkillPublicationFeedbackView,
  PrivateSkillPublicationView,
} from './PrivateSkillPublicationView';
import './PrivateSkills.css';

function skillStatus(skill: PrivateSkill) {
  return uiText(skill.available ? 'apps:privateSkillOriginal' : 'apps:privateSkillPrevious');
}
function skillOrigin(skill: PrivateSkill) {
  return uiText('apps:privateSkillOrigin', { version: skill.version, bot: skill.sourceAgentName });
}

export function PrivateSkillsPanel({
  scope,
  workspaceId,
  userId,
  onBusyChange,
  onChanged,
}: {
  scope: ReturnType<typeof createAppConnectionScope>;
  workspaceId?: string;
  userId?: string;
  onBusyChange: (busy: boolean) => void;
  onChanged?: () => void;
}) {
  const publicationBusy = useRef(false);
  const { shelf, selection, phase, feedback, unconfirmed, choose, refresh, update, isBusy } =
    usePrivateSkills(scope, onBusyChange, onChanged, () => publicationBusy.current);
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const scroll = panel.current?.closest('.apps-scroll');
    if (scroll) scroll.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
  }, [selection?.id, selection?.revision]);
  const skill =
    selection && shelf.skills.find((item) => privateSkillKey(item) === privateSkillKey(selection));
  const publication = usePrivateSkillPublication({
    scope,
    workspaceId,
    userId,
    skill: skill || undefined,
    busyRef: publicationBusy,
    isShelfBusy: isBusy,
    onBusyChange,
    onChanged,
  });
  const targets = skill ? privateSkillTargets(shelf, skill) : [];
  const target = targets.find((agent) => agent.id === selection?.targetId);
  const enabled = !!target && !!skill?.enabledAgentIds.includes(target.id);
  const earlier =
    skill?.available && target && !enabled
      ? shelf.skills.find(
          (item) =>
            privateSkillKey(item) !== privateSkillKey(skill) &&
            item.sourceAgentId === skill.sourceAgentId &&
            item.name === skill.name &&
            item.enabledAgentIds.includes(target.id),
        )
      : undefined;
  const busy = phase !== 'idle' || publication.busy;
  return (
    <section className="private-skills-panel" ref={panel}>
      <div className="private-skills-toolbar">
        {selection ? (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => choose(null)}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            {uiText('apps:privateSkillsBack')}
          </button>
        ) : (
          <p className="field-help">{uiText('apps:privateSkillsHelp')}</p>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw
            size={14}
            className={phase === 'read' ? 'spin' : undefined}
            aria-hidden="true"
          />
          {uiText('apps:privateSkillsRefresh')}
        </button>
      </div>
      {feedback && (
        <p
          className={feedback.kind === 'error' ? 'error-text' : 'field-help'}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      )}
      <PrivateSkillPublicationFeedbackView model={publication} disabled={busy} />
      {skill && selection ? (
        <article className="private-skill-review" aria-label={skill.name}>
          <h3 ref={heading} tabIndex={-1}>
            {skill.name}
          </h3>
          <p className="field-help">
            {skillOrigin(skill)} · {skillStatus(skill)}
          </p>
          {skill.description && <p>{skill.description}</p>}
          <dl className="private-skill-revision">
            <dt>{uiText('apps:privateSkillRevision')}</dt>
            <dd>
              <code>{skill.revision}</code>
            </dd>
          </dl>
          <section aria-label={uiText('apps:privateSkillContent')}>
            <h4>{uiText('apps:privateSkillContent')}</h4>
            <pre>{skill.content}</pre>
          </section>
          {workspaceId && userId && skill.available && !skill.description.trim() && (
            <p className="field-help">{uiText('apps:privateSkillPublicationNeedsDescription')}</p>
          )}
          <PrivateSkillPublicationView model={publication} skill={skill} disabled={busy} />
          <div className="private-skill-target">
            {targets.length ? (
              <>
                <label>
                  {uiText('apps:privateSkillTarget')}
                  <select
                    value={selection.targetId}
                    disabled={busy}
                    onChange={(event) => choose({ ...selection, targetId: event.target.value })}
                  >
                    <option value="">{uiText('apps:privateSkillChooseBot')}</option>
                    {targets.map((agent) => (
                      <option value={agent.id} key={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
                {target && (
                  <p className="field-help">
                    {uiText(enabled ? 'apps:privateSkillOnTarget' : 'apps:privateSkillOffTarget', {
                      bot: target.name,
                    })}
                  </p>
                )}
                {earlier && target ? (
                  <>
                    <p className="field-help">{uiText('apps:privateSkillEarlierPinned')}</p>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        choose({ id: earlier.id, revision: earlier.revision, targetId: target.id })
                      }
                    >
                      {uiText('apps:privateSkillReviewInstalled')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={enabled ? 'secondary-button' : 'primary-button'}
                    disabled={busy || unconfirmed || !target || (!enabled && !skill.available)}
                    onClick={() => void update(selection, !enabled)}
                  >
                    {phase === 'write' && <Loader2 size={14} className="spin" aria-hidden="true" />}
                    {uiText(enabled ? 'apps:privateSkillDisable' : 'apps:privateSkillEnable')}
                  </button>
                )}
              </>
            ) : (
              <p className="field-help">{uiText('apps:privateSkillNoTarget')}</p>
            )}
          </div>
        </article>
      ) : shelf.skills.length ? (
        <ul className="private-skill-list">
          {shelf.skills.map((item) => (
            <li key={privateSkillKey(item)}>
              <button
                type="button"
                className="integration"
                disabled={busy}
                onClick={() => choose({ id: item.id, revision: item.revision, targetId: '' })}
              >
                <span className="integration-icon lavender">
                  <BookOpen size={16} aria-hidden="true" />
                </span>
                <span>
                  <strong>{item.name}</strong>
                  <small>{skillOrigin(item)}</small>
                  <small>
                    {skillStatus(item)} ·{' '}
                    {uiText('apps:privateSkillInstalledCount', {
                      count: item.enabledAgentIds.filter((id) => id !== item.sourceAgentId).length,
                    })}
                  </small>
                </span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : phase === 'read' ? (
        <p className="apps-connections-empty" role="status">
          <Loader2 size={16} className="spin" aria-hidden="true" />
          {uiText('apps:privateSkillsLoading')}
        </p>
      ) : !feedback || feedback.kind === 'status' ? (
        <p className="apps-connections-empty" role="status">
          {uiText('apps:privateSkillsEmpty')}
        </p>
      ) : null}
    </section>
  );
}
