import { serviceText } from '../i18n/serviceText';
import { uiText } from '../i18n';
import { CheckCheck, Clock3, Info, Link2, Reply, X } from 'lucide-react';
import { MESSAGE_REACTIONS, type Message } from '../../../shared/types';
export function quoteText(content: string) {
  return content.replace(/\s+/g, ' ').trim() || uiText('common:text_5171dac6ea10');
}
export function MessageAppContext({ message }: { message: Message }) {
  if (message.role !== 'user' || !message.appContext) return null;
  return (
    <div className="message-app-context">
      <Link2 size={14} aria-hidden="true" />
      {uiText('workspace:composerAppSelected', { name: message.appContext.name })}
    </div>
  );
}
export function QuotedMessage({
  quote,
  onJump,
}: {
  quote: NonNullable<Message['replyTo']>;
  onJump: () => void;
}) {
  return (
    <button
      type="button"
      className="quoted-message"
      onClick={onJump}
      title={uiText('common:text_ae8b74945db0')}
    >
      <Reply size={13} />
      <span>
        <strong>{quote.author}</strong>
        <span>{quoteText(quote.content)}</span>
      </span>
    </button>
  );
}
export function ComposerReply({
  quote,
  onJump,
  onCancel,
}: {
  quote: NonNullable<Message['replyTo']>;
  onJump: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="composer-reply">
      <Reply size={15} />
      <button type="button" className="composer-reply-content" onClick={onJump}>
        <strong>
          {uiText('common:text_3376176cc70d')}
          {quote.author}
        </strong>
        <span>{quoteText(quote.content)}</span>
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={uiText('common:text_4bfc8056a1e4')}
        title={uiText('common:text_4bfc8056a1e4')}
        onClick={onCancel}
      >
        <X size={15} />
      </button>
    </div>
  );
}
type ReactionProps = {
  message: Message;
  currentUserId?: string;
  busy: boolean;
  onReact: (emoji: string, active: boolean) => void;
};

function ReactionButtons({
  message,
  currentUserId,
  busy,
  onReact,
  chips,
}: ReactionProps & {
  chips?: boolean;
}) {
  const emojis = chips
    ? MESSAGE_REACTIONS.filter((emoji) => message.reactions?.includes(emoji))
    : MESSAGE_REACTIONS;
  return emojis.map((emoji) => {
    const active = currentUserId
      ? !!message.reactionMembers?.[emoji]?.includes(currentUserId)
      : !!message.reactions?.includes(emoji);
    const count = chips && message.reactionMembers?.[emoji]?.length;
    return (
      <button
        type="button"
        key={emoji}
        className={[chips && 'reaction-chip', active && 'selected'].filter(Boolean).join(' ')}
        aria-pressed={active}
        aria-label={uiText('common:text_524caf5b144f', {
          value0: uiText(active ? 'common:text_2cd0f3be8738' : 'common:text_7a8a11ead507'),
          value1: emoji,
        })}
        disabled={busy}
        onClick={() => onReact(emoji, !active)}
      >
        {emoji}
        {count ? <span>{count}</span> : null}
      </button>
    );
  });
}

export function MessageReactions(props: ReactionProps) {
  if (!props.message.reactions?.length) return null;
  return (
    <div className="reaction-chips">
      <ReactionButtons {...props} chips />
    </div>
  );
}

export function ReactionChoices({ onClose, ...props }: ReactionProps & { onClose: () => void }) {
  return (
    <>
      <ReactionButtons {...props} />
      <button type="button" aria-label={uiText('common:text_6b2bc504a1e3')} onClick={onClose}>
        <X size={14} aria-hidden="true" />
      </button>
    </>
  );
}
export function DeliveryNotice({
  delivery,
  agentName,
  compact = false,
}: {
  delivery: NonNullable<Message['delivery']>;
  agentName?: string;
  compact?: boolean;
}) {
  const text =
    delivery.state === 'queued'
      ? delivery.mode === 'followUp'
        ? uiText('common:text_64dd779da08f')
        : uiText('common:text_c91422bda9dc')
      : delivery.state === 'delivered'
        ? uiText('common:text_35f81fee7ade', { value0: agentName || ' Bot' })
        : delivery.state === 'cancelled'
          ? uiText('common:text_d8548391fe9b')
          : uiText('common:text_562728e20a39');
  if (compact && delivery.state === 'delivered') {
    return (
      <span className="delivery-check" title={text}>
        <CheckCheck size={12} role="img" aria-label={text} />
      </span>
    );
  }
  return (
    <div
      className={`delivery-notice delivery-${delivery.state}`}
      title={serviceText(delivery.reason) || text}
    >
      {delivery.state === 'queued' ? (
        <Clock3 size={11} />
      ) : delivery.state === 'delivered' ? (
        <CheckCheck size={11} />
      ) : (
        <Info size={11} />
      )}
      <span>{text}</span>
      {delivery.reason && (delivery.state === 'cancelled' || delivery.state === 'interrupted') && (
        <small>{serviceText(delivery.reason)}</small>
      )}
    </div>
  );
}
