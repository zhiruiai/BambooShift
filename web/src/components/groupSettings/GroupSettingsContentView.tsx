import { uiText } from '../../i18n';
import { Check, Loader2, RefreshCw, Users } from 'lucide-react';
import { canEditGroupMembers, GROUP_MAX_MEMBERS } from '../../../../shared/group-members';
import { GROUP_SETTINGS_LIMITS } from '../../../../shared/group-settings';
import { Avatar } from '../Avatar';
import '../GroupSettingsDialog.css';
import { Dialog } from '../UI';
import { payload, toDraft } from './parts';
import type { useGroupSettingsContent } from './useGroupSettingsContent';
export type GroupSettingsContentModel = ReturnType<typeof useGroupSettingsContent>;
export function GroupSettingsContentView(model: GroupSettingsContentModel) {
  const {
    close,
    error,
    notice,
    leave,
    setLeave,
    current,
    running,
    latest,
    review,
    loading,
    saving,
    read,
    observed,
    props,
    dirty,
    setReplace,
    accept,
    setBase,
    baseline,
    setObserved,
    setReview,
    reviewRef,
    setError,
    setNotice,
    replace,
    base,
    save,
    locked,
    draft,
    update,
    members,
    draftRef,
  } = model;
  return (
    <Dialog
      title={uiText('settings:text_5098a74928d1')}
      subtitle={uiText('settings:text_f609aadb80d9')}
      className="group-settings-dialog"
      onClose={close}
    >
      {error && (
        <p className="error-text" role="alert">
          {error}
          {uiText('settings:text_396a5b4082d0')}
        </p>
      )}
      {notice && (
        <p className="group-settings-notice" role="status">
          {notice}
        </p>
      )}
      {leave && (
        <div className="group-settings-notice">
          <p>{uiText('settings:text_f3d94e24970c')}</p>
          <button className="secondary-button" type="button" onClick={() => setLeave(false)}>
            {uiText('settings:text_fd4b9e3b6c68')}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              if (current() && !running.current) latest.current.onClose();
            }}
          >
            {uiText('settings:text_0711cc459572')}
          </button>
        </div>
      )}
      {review && (
        <div className="group-settings-notice">
          <p>{uiText('settings:text_081648d0bc87')}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={loading || saving}
            onClick={() => void read()}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            {uiText('settings:text_1ba48cafb80f')}
          </button>
        </div>
      )}
      {observed && (
        <section className="group-settings-observed">
          <h3>{uiText('settings:text_77ef511b045d')}</h3>
          <p>
            {observed.conversation.title}
            {uiText('settings:text_d7e0b41f5dd8')}
            {props.agents.find((agent) => agent.id === observed.conversation.agentIds[0])?.name ||
              uiText('settings:text_0583e9855b7b')}{' '}
            · {observed.conversation.agentIds.length}
            {uiText('settings:text_e0c44489ceaf')}
          </p>
          <p>
            {uiText('settings:text_c73b90f7353b')}
            {observed.conversation.agentIds
              .map(
                (id) =>
                  props.agents.find((agent) => agent.id === id)?.name ||
                  uiText('settings:text_0583e9855b7b'),
              )
              .join(uiText('common:punct_c4a40ea8fe35'))}
          </p>
          {observed.conversation.teamBrief && (
            <details>
              <summary>{uiText('settings:text_d98ce7d2f483')}</summary>
              <p>{observed.conversation.teamBrief.goal}</p>
              <p>{observed.conversation.teamBrief.summary}</p>
              {observed.conversation.teamBrief.assignments.map((item) => (
                <p key={item.agentId}>
                  <strong>
                    {props.agents.find((agent) => agent.id === item.agentId)?.name ||
                      uiText('settings:text_0583e9855b7b')}
                    {uiText('common:punct_f114611cd610')}
                  </strong>
                  {item.assignment}
                </p>
              ))}
            </details>
          )}
          <div className="group-settings-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={loading || saving}
              onClick={() => {
                if (!current() || running.current) return;
                if (dirty) setReplace(true);
                else accept(observed);
              }}
            >
              {uiText('settings:text_c4ce39f9f376')}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={loading || saving}
              onClick={() => {
                if (!current() || running.current) return;
                setBase(observed);
                baseline.current = JSON.stringify(payload(toDraft(observed.conversation)));
                setObserved(undefined);
                setReview(false);
                reviewRef.current = false;
                setError('');
                setNotice(uiText('settings:text_9c889a03cc1b'));
              }}
            >
              {uiText('settings:text_6f6cc943c8f8')}
            </button>
          </div>
          {replace && (
            <div className="group-settings-notice">
              <p>{uiText('settings:text_b195287ddb35')}</p>
              <button type="button" className="secondary-button" onClick={() => setReplace(false)}>
                {uiText('settings:text_5334c70d7836')}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  if (current() && !running.current) {
                    accept(observed);
                    setError('');
                  }
                }}
              >
                {uiText('settings:text_f5f5f71cc815')}
              </button>
            </div>
          )}
        </section>
      )}
      {loading && !base ? (
        <p className="field-help">{uiText('settings:text_b600c27e1e18')}</p>
      ) : (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            {uiText('settings:text_12633e741c9a')}
            <input
              required
              maxLength={GROUP_SETTINGS_LIMITS.title}
              disabled={locked}
              value={draft.title}
              onChange={(event) => update((value) => ({ ...value, title: event.target.value }))}
            />
          </label>
          <label>
            {uiText('settings:text_a525346277ed')}
            <select
              value={draft.agentIds[0] || ''}
              disabled={locked || !members.length}
              onChange={(event) =>
                update((value) => ({
                  ...value,
                  agentIds: [
                    event.target.value,
                    ...value.agentIds.filter((id) => id !== event.target.value),
                  ],
                }))
              }
            >
              {!members.length && <option value="">{uiText('settings:text_7bb708c695e1')}</option>}
              {members.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <p className="field-help">{uiText('settings:text_bb60d84a7092')}</p>
          {!!base && base.conversation.agentIds.length > GROUP_MAX_MEMBERS && (
            <p className="group-settings-notice">
              {uiText('settings:text_efa9025599bb')}
              {base.conversation.agentIds.length} {uiText('settings:text_a10d41d48bc7')}
              {GROUP_MAX_MEMBERS} {uiText('settings:text_feabc12df203')}
            </p>
          )}
          <fieldset className="group-member-picker" disabled={locked}>
            <legend>
              {uiText('settings:text_a6ec5d1c6a76')}
              {draft.agentIds.length}/
              {Math.max(GROUP_MAX_MEMBERS, base?.conversation.agentIds.length || 0)}
            </legend>
            {[
              ...props.agents,
              ...members.filter((agent) => !props.agents.some((item) => item.id === agent.id)),
            ].map((agent) => (
              <label key={agent.id}>
                <Avatar agent={agent} size={30} />
                <span>
                  {agent.name}
                  <small>{agent.role}</small>
                </span>
                <input
                  type="checkbox"
                  aria-label={uiText('settings:text_074a6fc7b65a', { value0: agent.name })}
                  checked={draft.agentIds.includes(agent.id)}
                  disabled={
                    locked ||
                    (!draft.agentIds.includes(agent.id) &&
                      !canEditGroupMembers(base?.conversation.agentIds || [], [
                        ...draft.agentIds,
                        agent.id,
                      ]))
                  }
                  onChange={(event) => {
                    if (
                      event.target.checked &&
                      (!base ||
                        !canEditGroupMembers(base.conversation.agentIds, [
                          ...draftRef.current.agentIds,
                          agent.id,
                        ]))
                    )
                      return;
                    update((value) => ({
                      ...value,
                      agentIds: event.target.checked
                        ? [...value.agentIds, agent.id]
                        : value.agentIds.filter((id) => id !== agent.id),
                    }));
                  }}
                />
              </label>
            ))}
          </fieldset>
          {draft.teamBrief && (
            <section className="group-plan-fields">
              <h3>{uiText('settings:text_b1ee0f8fe74c')}</h3>
              <label>
                {uiText('settings:text_822d091cf6ff')}
                <textarea
                  rows={3}
                  maxLength={GROUP_SETTINGS_LIMITS.goal}
                  disabled={locked}
                  value={draft.teamBrief.goal}
                  onChange={(event) =>
                    update((value) => ({
                      ...value,
                      teamBrief: { ...value.teamBrief!, goal: event.target.value },
                    }))
                  }
                />
              </label>
              <label>
                {uiText('settings:text_cee9e1ab33e4')}
                <textarea
                  rows={3}
                  maxLength={GROUP_SETTINGS_LIMITS.summary}
                  disabled={locked}
                  value={draft.teamBrief.summary}
                  onChange={(event) =>
                    update((value) => ({
                      ...value,
                      teamBrief: { ...value.teamBrief!, summary: event.target.value },
                    }))
                  }
                />
              </label>
              {members.map((agent) => (
                <label key={agent.id}>
                  {agent.name}
                  {uiText('settings:text_cca4c2ccdd95')}
                  <textarea
                    rows={3}
                    maxLength={GROUP_SETTINGS_LIMITS.assignment}
                    disabled={locked}
                    value={
                      draft.teamBrief!.assignments.find((item) => item.agentId === agent.id)
                        ?.assignment || ''
                    }
                    onChange={(event) =>
                      update((value) => ({
                        ...value,
                        teamBrief: {
                          ...value.teamBrief!,
                          assignments: [
                            ...value.teamBrief!.assignments.filter(
                              (item) => item.agentId !== agent.id,
                            ),
                            { agentId: agent.id, assignment: event.target.value },
                          ],
                        },
                      }))
                    }
                  />
                </label>
              ))}
            </section>
          )}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" disabled={saving} onClick={close}>
              {uiText('settings:text_3fd47edce45b')}
            </button>
            <button className="primary-button" disabled={locked || loading || review || !dirty}>
              {saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
              {uiText('settings:text_937fc1d4279a')}
            </button>
          </div>
        </form>
      )}
      {!review && (
        <button
          className="text-button"
          type="button"
          disabled={saving || loading}
          onClick={() => void read()}
        >
          <RefreshCw size={14} />
          {uiText('settings:text_ac6257fd7bca')}
        </button>
      )}
      <p className="field-help">
        <Users size={13} />
        {uiText('settings:text_7638c7e91ea6')}
      </p>
    </Dialog>
  );
}
