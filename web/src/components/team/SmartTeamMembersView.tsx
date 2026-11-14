import { uiText } from '../../i18n';
import { Trash2 } from 'lucide-react';
import { GROUP_MIN_MEMBERS } from '../../../../shared/group-members';
import { botProfileDraft } from '../../botProfiles';
import { Avatar } from '../Avatar';
import { BotProfileFields } from '../BotProfileFields';
import '../SmartTeamPanel.css';
import { type SmartTeamModel } from './types';
export function SmartTeamMembersView({
  draft,
  props,
  update,
  locked,
  avatarEdits,
  commitRequest,
  latest,
  newMemberDrafts,
  invalidateCatalogPreview,
  dirty,
  goalChanged,
  busy,
  scope,
  running,
  catalogRequestRef,
  uncertainRef,
  setDraft,
  setNotice,
}: Pick<
  SmartTeamModel,
  | 'draft'
  | 'props'
  | 'update'
  | 'locked'
  | 'avatarEdits'
  | 'commitRequest'
  | 'latest'
  | 'newMemberDrafts'
  | 'invalidateCatalogPreview'
  | 'dirty'
  | 'goalChanged'
  | 'busy'
  | 'scope'
  | 'running'
  | 'catalogRequestRef'
  | 'uncertainRef'
  | 'setDraft'
  | 'setNotice'
>) {
  if (!draft) return null;
  return (
    <>
      <div className="smart-team-members">
        {draft.members.map((member, index) => {
          const agent =
            member.kind === 'reuse'
              ? props.agents.find((item) => item.id === member.agentId)
              : member;
          const patch = (next: typeof member) =>
            update({
              ...draft,
              members: draft.members.map((item) => (item.key === member.key ? next : item)),
            });
          return (
            <section className="smart-team-member" key={member.key}>
              <header>
                <Avatar agent={agent} size={32} />
                <strong>{agent?.name || uiText('bots:text_45bf847b470d')}</strong>
                <span>
                  {member.key === draft.leadKey
                    ? uiText('bots:text_a525346277ed')
                    : uiText('bots:text_7c2dbf2f1c1b', { value0: index + 1 })}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={uiText('bots:text_ed35fa4648e8', { value0: index + 1 })}
                  disabled={
                    locked ||
                    avatarEdits.pending ||
                    !!commitRequest.current ||
                    draft.members.length <= GROUP_MIN_MEMBERS
                  }
                  onClick={() => {
                    if (latest.current.draft !== draft || draft.members.length <= GROUP_MIN_MEMBERS)
                      return;
                    const members = draft.members.filter((item) => item.key !== member.key);
                    newMemberDrafts.current.delete(member.key);
                    update({
                      ...draft,
                      members,
                      leadKey: draft.leadKey === member.key ? members[0].key : draft.leadKey,
                    });
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </header>
              <label>
                {uiText('bots:text_c15b9e74e7bd')}
                <select
                  disabled={locked || avatarEdits.pending || !!commitRequest.current}
                  value={member.kind === 'reuse' ? member.agentId : 'new'}
                  onChange={(event) => {
                    if (latest.current.draft !== draft) return;
                    if (member.kind === 'create')
                      newMemberDrafts.current.set(member.key, { ...member });
                    patch(
                      event.target.value === 'new'
                        ? {
                            ...(newMemberDrafts.current.get(member.key) || botProfileDraft()),
                            key: member.key,
                            kind: 'create',
                            assignment: member.assignment,
                          }
                        : {
                            key: member.key,
                            kind: 'reuse',
                            agentId: event.target.value,
                            assignment: member.assignment,
                          },
                    );
                  }}
                >
                  <option value="new">{uiText('bots:text_49542924a2cc')}</option>
                  {props.agents.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.role}
                    </option>
                  ))}
                </select>
              </label>
              {member.kind === 'create' && (
                <details>
                  <summary>{uiText('bots:text_36b393923130')}</summary>
                  <div className="dialog-form">
                    <BotProfileFields
                      modelSelection
                      key={avatarEdits.resetKey}
                      draft={member}
                      disabled={locked || !!commitRequest.current}
                      workspaceId={props.workspaceId}
                      userId={props.userId}
                      onAvatarActivity={(value) => {
                        if (value.pending || value.busy) invalidateCatalogPreview();
                        avatarEdits.set(member.key, value);
                        latest.current.props.onDirty(
                          dirty ||
                            goalChanged ||
                            avatarEdits.current().pending ||
                            avatarEdits.current().changed,
                        );
                        latest.current.props.onBusy(busy || avatarEdits.current().busy);
                      }}
                      onAvatarChange={(profile) => {
                        if (
                          !scope.current(scope.ticket()) ||
                          running.current ||
                          commitRequest.current ||
                          catalogRequestRef.current ||
                          latest.current.props.disabled ||
                          uncertainRef.current
                        )
                          return;
                        invalidateCatalogPreview();
                        avatarEdits.markChanged();
                        latest.current.props.onDirty(true);
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                members: current.members.map((item) =>
                                  item.key === member.key && item.kind === 'create'
                                    ? { ...item, ...profile }
                                    : item,
                                ),
                              }
                            : current,
                        );
                        setNotice('');
                      }}
                      onChange={(profile) => patch({ ...member, ...profile })}
                    />
                  </div>
                </details>
              )}
              <label>
                {uiText('bots:text_919ff0cdb92f')}
                <textarea
                  rows={3}
                  maxLength={2000}
                  disabled={locked || !!commitRequest.current}
                  value={member.assignment}
                  onChange={(event) => patch({ ...member, assignment: event.target.value })}
                />
              </label>
            </section>
          );
        })}
      </div>
    </>
  );
}
