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
  compactCreation = false,
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
  compactCreation?: boolean;
}) {
  const avatar = (
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
  );
  const identity = (
    <>
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
    </>
  );
  const options = (
    <>
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
  );
  const instructions = (
    <>
      <label>
        {uiText('bots:text_f34d18b15b71')}
        <textarea
          rows={compactCreation ? 4 : 7}
          maxLength={16000}
          disabled={disabled}
          value={draft.instructions}
          onChange={(event) => onChange({ ...draft, instructions: event.target.value })}
          placeholder={uiText('bots:text_61a0c648b23c')}
        />
      </label>
      {!compactCreation && <p className="field-help">{uiText('bots:text_4e76a9aae809')}</p>}
    </>
  );
  if (compactCreation)
    return (
      <>
        <div className="bot-create-identity">{identity}</div>
        {instructions}
        <details className="bot-create-options">
          <summary>{uiText('workspace:creationBotOptions')}</summary>
          <div className="dialog-form">
            {avatar}
            {options}
          </div>
        </details>
      </>
    );
  return (
    <>
      {section !== 'instructions' && (
        <>
          {avatar}
          {identity}
          {options}
        </>
      )}
      {section !== 'profile' && instructions}
    </>
  );
}
