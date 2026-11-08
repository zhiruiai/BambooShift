import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type { TeamSkillPublishingPolicy as Policy } from '../../../../shared/team-skills';
import { uiText } from '../../i18n';
import { platformApi, PlatformApiError } from '../platformApi';

function checkedPolicy(value: Policy, requested?: boolean): Policy {
  if (
    !value ||
    typeof value.memberPublishing !== 'boolean' ||
    typeof value.revision !== 'string' ||
    !/^(?:unset|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/.test(value.revision) ||
    (value.revision === 'unset' && value.memberPublishing) ||
    (requested !== undefined && value.memberPublishing !== requested)
  )
    throw new Error('Invalid team skill policy response.');
  return value;
}

export function TeamSkillPublishingPolicy({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId: string;
}) {
  const [policy, setPolicy] = useState<Policy>();
  const [selection, setSelection] = useState(false);
  const [busy, setBusy] = useState(true);
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'notice'; text: string }>();
  const active = useRef<AbortController>(undefined);
  const identity = `${workspaceId}:${userId}`;
  const latest = useRef(identity);
  latest.current = identity;
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/team-skills/publishing-policy`;

  async function run(change?: { value: boolean; revision: string }) {
    if (active.current || latest.current !== identity) return;
    const request = new AbortController();
    active.current = request;
    setBusy(true);
    setFeedback(undefined);
    const current = () => active.current === request && latest.current === identity;
    try {
      const value = checkedPolicy(
        await platformApi<Policy>(
          path,
          change ? 'PUT' : 'GET',
          change
            ? { memberPublishing: change.value, expectedRevision: change.revision }
            : undefined,
          { expectedUser: userId, signal: request.signal },
        ),
        change?.value,
      );
      if (!current()) return;
      setPolicy(value);
      setSelection(value.memberPublishing);
      if (change) setFeedback({ kind: 'notice', text: uiText('common:teamSkillPolicySaved') });
    } catch (cause) {
      if (!current()) return;
      setPolicy(undefined);
      setFeedback({
        kind: 'error',
        text: uiText(
          cause instanceof PlatformApiError && cause.code === 'TEAM_SKILL_POLICY_CHANGED'
            ? 'common:teamSkillPolicyChanged'
            : change
              ? 'common:teamSkillPolicyUnconfirmed'
              : 'common:teamSkillPolicyReadFailed',
        ),
      });
    } finally {
      if (current()) {
        active.current = undefined;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    setPolicy(undefined);
    void run();
    return () => {
      active.current?.abort();
      active.current = undefined;
    };
  }, [path, userId]);

  return (
    <section className="platform-section template-sharing-policy">
      <div className="platform-section-heading">
        <div>
          <h2>{uiText('common:teamSkillPolicyTitle')}</h2>
          <p>{uiText('common:teamSkillPolicyHelp')}</p>
        </div>
      </div>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (policy && selection !== policy.memberPublishing) {
            void run({ value: selection, revision: policy.revision });
          }
        }}
      >
        <label>
          {uiText('common:teamSkillPolicyWho')}
          <select
            value={policy ? (selection ? 'members' : 'owner') : ''}
            disabled={busy || !policy}
            onChange={(event) => setSelection(event.currentTarget.value === 'members')}
          >
            {!policy && <option value="">{uiText('common:teamSkillPolicyUnread')}</option>}
            <option value="owner">{uiText('common:teamSkillPolicyOwners')}</option>
            <option value="members">{uiText('common:teamSkillPolicyMembers')}</option>
          </select>
        </label>
        {feedback && (
          <p
            className={`platform-${feedback.kind}`}
            role={feedback.kind === 'error' ? 'alert' : 'status'}
          >
            {feedback.text}
          </p>
        )}
        <div className="template-policy-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void run()}
          >
            {busy ? (
              <Loader2 size={14} className="spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}
            {uiText('common:refresh')}
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !policy || selection === policy.memberPublishing}
          >
            {uiText('common:save')}
          </button>
        </div>
      </form>
    </section>
  );
}
