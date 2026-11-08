import { useState } from 'react';
import type { Message } from '../../../shared/types';
import type { BotProfileDraft } from '../botProfiles';
import { parseCreationPreview } from '../creationPreview';
import { uiText } from '../i18n';
import { useAvatarAppearance } from '../avatarAppearance';
import { CreationDraftSummary } from './CreationBrief';

export function CreationDraftCard({
  message,
  owner,
  current,
  onProfile,
}: {
  message: Message;
  owner: boolean;
  current: () => boolean;
  onProfile: (profile: BotProfileDraft) => void;
}) {
  const appearance = useAvatarAppearance();
  const [applied, setApplied] = useState(false);
  const raw = message.metadata?.creationPreview;
  const kind = raw && typeof raw === 'object' && 'kind' in raw && raw.kind;
  const draft =
    message.role === 'assistant' &&
    message.kind === 'creation_preview' &&
    message.status === 'done' &&
    (kind === 'bot' || kind === 'theme') &&
    parseCreationPreview(kind, raw);
  if (!draft) return <div className="message-bubble">{message.content}</div>;
  return (
    <div className="creation-brief-body">
      <strong>
        {uiText(draft.kind === 'bot' ? 'bots:smartProfileCard' : 'bots:smartThemeCard')}
      </strong>
      <CreationDraftSummary draft={draft} />
      {owner && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            if (!current()) return;
            if (draft.kind === 'bot') onProfile(draft.profile);
            else {
              appearance.updateAvatar({
                customAvatarTheme: draft.theme,
                useCustomAvatarTheme: true,
              });
              setApplied(true);
            }
          }}
        >
          {uiText(
            draft.kind === 'bot'
              ? 'bots:smartDraftEdit'
              : appearance.avatarSync?.synced || appearance.avatarSync?.preview
                ? 'settings:avatarSyncPreviewAction'
                : 'bots:smartThemeApply',
          )}
        </button>
      )}
      {applied &&
        appearance.useCustomAvatarTheme &&
        draft.kind === 'theme' &&
        JSON.stringify(appearance.customAvatarTheme) === JSON.stringify(draft.theme) && (
          <span role="status">
            {uiText(
              appearance.avatarSync?.preview
                ? 'settings:avatarSyncPreview'
                : 'bots:smartThemeApplied',
            )}
          </span>
        )}
    </div>
  );
}
