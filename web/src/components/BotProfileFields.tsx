import { uiText } from '../i18n';
import type { BotProfileDraft } from '../botProfiles';
import type { AvatarEditActivity } from '../avatarImages';
import { AvatarPicker } from './AvatarPicker';
import { BotModelSelect } from './BotModelSelect';
import './BotProfiles.css';
export function BotProfileFields({
  draft,
  onChange,
  disabled = false,
  section = 'all',
  workspaceId,
  userId,
  onAvatarActivity,
  onAvatarChange,
  modelSelection = false,
}: {
  draft: BotProfileDraft;
  onChange: (draft: BotProfileDraft) => void;
  disabled?: boolean;
  section?: 'profile' | 'instructions' | 'all';
  workspaceId?: string;
  userId?: string;
  onAvatarActivity?: (activity: AvatarEditActivity) => void;
  onAvatarChange?: (patch: Partial<BotProfileDraft>) => void;
  modelSelection?: boolean;
}) {
  return (
    <>
      {section !== 'instructions' && (
        <>
          <AvatarPicker
            draft={draft}
            disabled={disabled}
            workspaceId={workspaceId}
            userId={userId}
            onActivity={onAvatarActivity}
            onChange={(patch) =>
              onAvatarChange ? onAvatarChange(patch) : onChange({ ...draft, ...patch })
            }
          />
          <label>
            {uiText('bots:text_194154ae5bca')}
            <input
              required
              maxLength={40}
              disabled={disabled}
              value={draft.name}
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
              placeholder={uiText('bots:text_3790971df7ee')}
            />
          </label>
          <label>
            {uiText('bots:text_447f856340eb')}
            <input
              required
              maxLength={80}
              disabled={disabled}
              value={draft.role}
              onChange={(event) => onChange({ ...draft, role: event.target.value })}
              placeholder={uiText('bots:text_617e8e96f4d1')}
            />
          </label>
          <label>
            {uiText('bots:text_8131eafd0239')}
            <textarea
              rows={3}
              maxLength={1000}
              disabled={disabled}
              value={draft.description}
              onChange={(event) => onChange({ ...draft, description: event.target.value })}
              placeholder={uiText('bots:text_d3a302e11fd8')}
            />
          </label>
          {modelSelection && (
            <BotModelSelect
              key={`${workspaceId || ''}:${userId || ''}`}
              workspaceId={workspaceId}
              userId={userId}
              value={draft.modelProfileId}
              disabled={disabled}
              onChange={(modelProfileId) => onChange({ ...draft, modelProfileId })}
            />
          )}
        </>
      )}
      {section !== 'profile' && (
        <>
          <label>
            {uiText('bots:text_f34d18b15b71')}
            <textarea
              rows={7}
              maxLength={16000}
              disabled={disabled}
              value={draft.instructions}
              onChange={(event) => onChange({ ...draft, instructions: event.target.value })}
              placeholder={uiText('bots:text_61a0c648b23c')}
            />
          </label>
          <p className="field-help">{uiText('bots:text_4e76a9aae809')}</p>
        </>
      )}
    </>
  );
}
