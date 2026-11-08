import { uiText } from '../i18n';
import { BookOpen, ChevronRight } from 'lucide-react';
import type { BotTemplateCard as Card } from '../../../shared/bot-templates';
import { parseBotTemplatePath } from '../../../shared/bot-templates';
import './BotTemplates.css';
export function BotTemplateCard({
  card,
  owner,
  onManage,
  onOpenPublic,
}: {
  card: Card;
  owner: boolean;
  onManage: (id: string) => void;
  onOpenPublic?: (path: string) => void;
}) {
  const path =
    card.status === 'published' && card.path && parseBotTemplatePath(card.path)
      ? card.path
      : undefined;
  return (
    <section className="bot-template-card" aria-label={uiText('bots:text_0f77795ac6f1')}>
      <header>
        <BookOpen size={16} />
        <strong>{card.name}</strong>
        <small>
          {card.status === 'published'
            ? card.audience === 'team'
              ? uiText('bots:text_4e66b24fd230')
              : uiText('bots:text_cc0b0bca3d60')
            : card.status === 'revoked'
              ? uiText('bots:text_0b7a8ccf5201')
              : uiText('bots:text_439b2cc95c56')}
        </small>
      </header>
      <p>
        {card.status === 'published'
          ? uiText('bots:text_d63d5f27e0c7')
          : card.status === 'revoked'
            ? uiText('bots:text_3106a4a45cf1')
            : uiText('bots:text_fbf1e81a87cb')}
      </p>
      {owner ? (
        <button
          type="button"
          className="secondary-button"
          onClick={() => onManage(card.templateId)}
        >
          {uiText('bots:text_86e45f51cf3f')}
          <ChevronRight size={14} />
        </button>
      ) : path ? (
        <a
          className="secondary-button"
          href={path}
          onClick={(event) => {
            if (
              !onOpenPublic ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            onOpenPublic(path);
          }}
        >
          {uiText('bots:text_c11c5bc096b8')}
          <ChevronRight size={14} />
        </a>
      ) : (
        <p>{uiText('bots:text_4988ebbe69f7')}</p>
      )}
    </section>
  );
}
