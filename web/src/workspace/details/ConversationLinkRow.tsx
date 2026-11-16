import { Link2, Reply } from 'lucide-react';
import { uiText } from '../../i18n';
import './ConversationLinks.css';

export function ConversationLinkRow({
  href,
  label,
  onJump,
}: {
  href: string;
  label: string;
  onJump: () => void;
}) {
  const source = uiText('workspace:libraryLinkSource', { label });
  return (
    <div className="conversation-library-link">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <Link2 size={16} aria-hidden="true" />
        <span>
          <strong>{label}</strong>
          <small>{new URL(href).hostname}</small>
        </span>
      </a>
      <button
        type="button"
        className="icon-button"
        onClick={onJump}
        aria-label={source}
        title={source}
      >
        <Reply size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
