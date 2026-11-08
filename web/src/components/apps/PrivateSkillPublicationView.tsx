import { ArrowUpRight, Loader2, RefreshCw } from 'lucide-react';
import { uiText } from '../../i18n';
import type { PrivateSkill } from '../../privateSkills';
import { TeamSkillCopyLink } from '../TeamSkillCopyLink';
import type { usePrivateSkillPublication } from './usePrivateSkillPublication';

export type PublicationModel = ReturnType<typeof usePrivateSkillPublication>;

export function PrivateSkillPublicationFeedbackView({
  model,
  disabled,
}: {
  model: PublicationModel;
  disabled: boolean;
}) {
  return (
    <>
      {model.feedback && (
        <p
          className={model.feedback.tone === 'error' ? 'error-text' : 'field-help'}
          role={model.feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {model.feedback.text}
        </p>
      )}
      {model.pending && (
        <section
          className="private-skill-publication private-skill-publication-pending"
          aria-label={uiText('apps:privateSkillPublicationPending')}
        >
          <h4>{uiText('apps:privateSkillPublicationPending')}</h4>
          <p className="field-help">{uiText('apps:privateSkillPublicationRecoveryHelp')}</p>
          <div className="private-skill-publication-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={disabled}
              onClick={() => void model.resolve('check')}
            >
              {uiText('apps:privateSkillPublicationCheck')}
            </button>
            {model.canRetry && (
              <button
                className="secondary-button"
                type="button"
                disabled={disabled}
                onClick={() => void model.resolve('retry')}
              >
                {uiText('apps:privateSkillPublicationRetry')}
              </button>
            )}
            <button
              className="text-button"
              type="button"
              disabled={disabled}
              onClick={() => void model.resolve('cancel')}
            >
              {uiText('apps:privateSkillPublicationCancel')}
            </button>
          </div>
          {model.canDismiss && (
            <>
              <p className="field-help">{uiText('apps:privateSkillPublicationDismissHelp')}</p>
              <button
                className="text-button"
                type="button"
                disabled={disabled}
                onClick={model.dismiss}
              >
                {uiText('apps:privateSkillPublicationDismiss')}
              </button>
            </>
          )}
        </section>
      )}
    </>
  );
}

export function PrivateSkillPublicationView({
  model,
  skill,
  disabled,
}: {
  model: PublicationModel;
  skill: PrivateSkill;
  disabled: boolean;
}) {
  if (!model.eligible || model.pending) return null;
  const review = model.review;
  const team = review?.teams?.find((row) => row.workspaceId === review.teamId);
  const published = team?.publication;
  const synced = published?.sourceRevision === skill.revision;
  if (!review)
    return (
      <button
        type="button"
        className="secondary-button private-skill-publication-trigger"
        disabled={disabled}
        onClick={() => void model.open(skill)}
      >
        <ArrowUpRight size={15} aria-hidden="true" />
        {uiText('common:teamSkillPublish')}
      </button>
    );
  return (
    <section className="private-skill-publication" aria-label={uiText('common:teamSkillPublish')}>
      <div className="private-skill-publication-actions private-skill-publication-heading">
        <h4>{uiText('common:teamSkillPublish')}</h4>
        <button
          className="text-button"
          type="button"
          disabled={disabled}
          onClick={() => void model.open(skill)}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {uiText('apps:privateSkillPublicationRefresh')}
        </button>
      </div>
      {!review.teams ? (
        model.busy && (
          <p role="status">
            <Loader2 size={15} className="spin" aria-hidden="true" />{' '}
            {uiText('apps:privateSkillPublicationLoading')}
          </p>
        )
      ) : !review.teams.length ? (
        <p className="field-help">{uiText('apps:privateSkillPublicationNoTeams')}</p>
      ) : (
        <>
          <label>
            {uiText('apps:privateSkillPublicationTeam')}
            <select
              value={review.teamId}
              disabled={disabled}
              onChange={(event) => model.choose(event.target.value)}
            >
              <option value="">{uiText('apps:privateSkillPublicationChoose')}</option>
              {review.teams.map((row) => (
                <option key={row.workspaceId} value={row.workspaceId}>
                  {row.workspaceName}
                </option>
              ))}
            </select>
          </label>
          {team && (
            <>
              <p>
                {uiText('apps:privateSkillPublicationSourceVersion', { version: skill.version })}
              </p>
              {published && (
                <div className="private-skill-publication-actions">
                  <p>
                    {uiText('apps:privateSkillPublicationTeamVersion', {
                      version: published.version,
                    })}
                  </p>
                  <TeamSkillCopyLink
                    key={`${team.workspaceId}:${published.linkId}`}
                    teamId={team.workspaceId}
                    publicationId={published.id}
                    linkId={published.linkId}
                    disabled={disabled}
                  />
                </div>
              )}
              {synced ? (
                <p className="field-help" role="status">
                  {uiText('apps:privateSkillPublicationCurrent')}
                </p>
              ) : (
                <>
                  <p className="field-help">
                    {uiText('apps:privateSkillPublicationHelp', { team: team.workspaceName })}
                  </p>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={disabled || !model.ready}
                    onClick={() => model.publish(skill, team)}
                  >
                    {uiText(
                      published
                        ? 'apps:privateSkillPublicationSync'
                        : 'apps:privateSkillPublicationPublish',
                    )}
                  </button>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
