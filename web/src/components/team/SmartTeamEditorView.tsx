import { uiText } from '../../i18n';
import { Check, Loader2, Plus } from 'lucide-react';
import { GROUP_MAX_MEMBERS } from '../../../../shared/group-members';
import { botProfileDraft } from '../../botProfiles';
import '../SmartTeamPanel.css';
import { SmartTeamCatalogView } from './SmartTeamCatalogView';
import { SmartTeamMembersView } from './SmartTeamMembersView';
import type { SmartTeamModel } from './types';
export function SmartTeamEditorView(model: SmartTeamModel) {
  const {
    editable,
    commitRequest,
    revisionConflict,
    uncertain,
    locked,
    loading,
    resumeEditing,
    draft,
    update,
    props,
    avatarEdits,
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
    catalogLoading,
    reviewBots,
    catalogPreview,
    saveCatalog,
    mutate,
  } = model;
  if (!draft) return null;
  return (
    <>
      {editable && (
        <div className="dialog-form">
          {(commitRequest.current || revisionConflict) && (
            <div className="bot-form-notice">
              <p>
                {uncertain ? uiText('bots:text_153f16f2d9a8') : uiText('bots:text_a831f4eb4b5a')}
              </p>
              <button
                type="button"
                className="secondary-button"
                disabled={locked || loading}
                onClick={() => void resumeEditing()}
              >
                {uiText('bots:text_71dbbe658c97')}
              </button>
            </div>
          )}
          <label>
            {uiText('bots:text_12633e741c9a')}
            <input
              maxLength={100}
              disabled={locked || !!commitRequest.current}
              value={draft.title}
              onChange={(event) => update({ ...draft, title: event.target.value })}
            />
          </label>
          <label>
            {uiText('bots:text_cee9e1ab33e4')}
            <textarea
              rows={3}
              maxLength={2000}
              disabled={locked || !!commitRequest.current}
              value={draft.summary}
              onChange={(event) => update({ ...draft, summary: event.target.value })}
            />
          </label>
          <label>
            {uiText('bots:text_a525346277ed')}
            <select
              disabled={locked || !!commitRequest.current}
              value={draft.leadKey}
              onChange={(event) => update({ ...draft, leadKey: event.target.value })}
            >
              {draft.members.map((member) => (
                <option key={member.key} value={member.key}>
                  {member.kind === 'reuse'
                    ? props.agents.find((agent) => agent.id === member.agentId)?.name ||
                      uiText('bots:text_0583e9855b7b')
                    : member.name || uiText('bots:text_524153198cea')}
                </option>
              ))}
            </select>
          </label>
          <p className="field-help">{uiText('bots:text_4df5cb3ce1e3')}</p>
          <SmartTeamMembersView {...model} />
          <button
            type="button"
            className="secondary-button"
            disabled={
              locked || !!commitRequest.current || draft.members.length >= GROUP_MAX_MEMBERS
            }
            onClick={() => {
              if (latest.current.draft !== draft || draft.members.length >= GROUP_MAX_MEMBERS)
                return;
              const existing = props.agents.find(
                (agent) =>
                  !draft.members.some((item) => item.kind === 'reuse' && item.agentId === agent.id),
              );
              const key = `member_${crypto.randomUUID().slice(0, 8)}`;
              update({
                ...draft,
                members: [
                  ...draft.members,
                  existing
                    ? { key, kind: 'reuse', agentId: existing.id, assignment: '' }
                    : { ...botProfileDraft(), key, kind: 'create', assignment: '' },
                ],
              });
            }}
          >
            <Plus size={14} />
            {uiText('bots:text_cca24ce26810')}
            {GROUP_MAX_MEMBERS}
            {uiText('bots:text_5262cd9f9bdd')}
          </button>
          <SmartTeamCatalogView {...model} />
          <button
            type="button"
            className="primary-button"
            disabled={locked || avatarEdits.pending || (revisionConflict && !commitRequest.current)}
            onClick={() => void mutate('commit')}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
            {commitRequest.current
              ? uiText('bots:text_78cfaed34fd3')
              : uiText('bots:text_81d0f9d86247')}
          </button>
          {!commitRequest.current && !revisionConflict && (
            <button
              type="button"
              className="secondary-button"
              disabled={locked || avatarEdits.pending || !dirty}
              onClick={() => void resumeEditing()}
            >
              {uiText('bots:text_5329e3f0ee46')}
            </button>
          )}
          {avatarEdits.pending && <p className="field-help">{uiText('bots:text_4bff32d70305')}</p>}
        </div>
      )}
    </>
  );
}
