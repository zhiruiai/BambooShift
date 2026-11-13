import { displayAvatarColor } from '../../../shared/avatar-palette';
import { uiText } from '../i18n';

export function ChatMessageAuthorView({
  name,
  color,
  removed,
}: {
  name?: string;
  color?: string;
  removed: boolean;
}) {
  return (
    <div
      className="message-author"
      style={{ color: `color-mix(in srgb, ${displayAvatarColor(color)} 40%, var(--text))` }}
    >
      {name}
      {removed && <span className="removed-author">{uiText('workspace:text_174688c755b9')}</span>}
    </div>
  );
}
