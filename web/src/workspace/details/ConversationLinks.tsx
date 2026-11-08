import { useMemo, useState } from 'react';
import { ChevronRight, Link2 } from 'lucide-react';
import type { Message } from '../../../../shared/types';
import { uiText } from '../../i18n';
import { messageLinks } from '../../messageLinks';
import './ConversationLinks.css';

const PAGE_SIZE = 8;

export function ConversationLinks({
  conversationId,
  messages,
  onJump,
}: {
  conversationId: string;
  messages: Message[];
  onJump: (messageId: string) => void;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const entries = useMemo(() => {
    const seen = new Set<string>();
    return messages
      .filter((message) => message.conversationId === conversationId)
      .reverse()
      .flatMap((message) =>
        messageLinks(message).flatMap((link) => {
          if (seen.has(link.href)) return [];
          seen.add(link.href);
          return [{ ...link, messageId: message.id }];
        }),
      );
  }, [conversationId, messages]);
  if (!entries.length) return null;

  return (
    <section className="conversation-library-links" aria-label={uiText('workspace:libraryLinks')}>
      <p className="section-label">{uiText('workspace:libraryLinks')}</p>
      {entries.slice(0, limit).map(({ href, label, messageId }) => (
        <a
          key={href}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={uiText('workspace:libraryLinkSource', { label })}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onJump(messageId);
          }}
        >
          <Link2 size={16} aria-hidden="true" />
          <span>
            <strong>{label}</strong>
            <small>{new URL(href).hostname}</small>
          </span>
          <ChevronRight size={14} aria-hidden="true" />
        </a>
      ))}
      {entries.length > limit && (
        <button type="button" className="text-button" onClick={() => setLimit(limit + PAGE_SIZE)}>
          {uiText('workspace:libraryLinksMore')}
        </button>
      )}
    </section>
  );
}
