import { useEffect, useRef, type KeyboardEvent } from 'react';
import { CornerUpLeft, Ellipsis, Link2, Copy, MessageSquare, Reply, SmilePlus } from 'lucide-react';
import type { Message } from '../../../shared/types';
import { uiText } from '../i18n';
import type { WorkspaceVoice } from '../useVoice';
import { conversationHref } from '../workspace-scope';
import { ReactionChoices } from './MessageExtras';
import { VoiceMessageButton } from './VoiceControls';
import './MessageActions.css';

export type MessagePopup = 'reactions' | 'more';

export function MessageActions({
  message,
  currentUserId,
  current,
  voice,
  popup,
  onPopup,
  busy,
  onReact,
  onReply,
  onThread,
  onJump,
  copy,
}: {
  message: Message;
  currentUserId?: string;
  current: () => boolean;
  voice: WorkspaceVoice;
  popup: MessagePopup | null;
  onPopup: (value: MessagePopup | null) => void;
  busy: boolean;
  onReact?: (emoji: string, active: boolean) => void;
  onReply?: () => void;
  onThread?: () => void;
  onJump?: () => void;
  copy: (value: string) => Promise<void>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const reactionsButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const popupId = `message-actions-${message.id}`;
  const copyText = message.content.trim()
    ? message.content
    : message.kind === 'file' && typeof message.metadata?.name === 'string'
      ? message.metadata.name
      : '';
  const enabled = () => root.current?.isConnected && current();
  const buttons = () =>
    Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
  const trigger = () => (popup === 'reactions' ? reactionsButton : moreButton).current;

  function close(restoreFocus = false) {
    if (!enabled()) return false;
    onPopup(null);
    if (restoreFocus) trigger()?.focus({ preventScroll: true });
    return true;
  }

  useEffect(() => {
    const container = root.current;
    const content = panel.current;
    if (!popup || !container || !content) return;
    const viewport = container.closest('.messages-scroll');
    if (viewport) {
      const bounds = viewport.getBoundingClientRect();
      const anchor = container.getBoundingClientRect();
      const popupBounds = content.getBoundingClientRect();
      const height = popupBounds.height;
      if (anchor.top - bounds.top < height + 6 && bounds.bottom - anchor.bottom > height + 6)
        content.dataset.below = 'true';
      const shift =
        Math.max(0, bounds.left + 4 - popupBounds.left) -
        Math.max(0, popupBounds.right - bounds.right + 4);
      content.style.translate = `${shift}px`;
    }
    buttons()[0]?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (!container.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    const scroll = () => close();
    viewport?.addEventListener('scroll', scroll, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      viewport?.removeEventListener('scroll', scroll);
    };
  }, [popup]);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || !enabled()) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      onPopup('more');
      return;
    }
    if (!popup) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!panel.current?.contains(event.target as Node)) return;
    const choices = buttons();
    if (!choices.length) return;
    const index = choices.indexOf(event.target as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = choices.length - 1;
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        next = (index + 1) % choices.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (index - 1 + choices.length) % choices.length;
        break;
      default:
        return;
    }
    event.preventDefault();
    choices[next]?.focus({ preventScroll: true });
  }

  function toggle(value: MessagePopup) {
    if (enabled()) onPopup(popup === value ? null : value);
  }

  return (
    <div className="message-actions" ref={root} onKeyDown={keyDown}>
      <div className="message-action-buttons" data-open={!!popup}>
        {onReact && (
          <button
            type="button"
            ref={reactionsButton}
            aria-label={uiText('workspace:text_60cb5536c056')}
            title={uiText('workspace:text_60cb5536c056')}
            aria-expanded={popup === 'reactions'}
            aria-controls={popup === 'reactions' ? popupId : undefined}
            onClick={() => toggle('reactions')}
          >
            <SmilePlus size={15} aria-hidden="true" />
          </button>
        )}
        {onReply && (
          <button
            type="button"
            aria-label={uiText('workspace:text_b83bb87b0452')}
            title={uiText('workspace:text_b83bb87b0452')}
            onClick={() => {
              if (close()) onReply();
            }}
          >
            <Reply size={15} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          ref={moreButton}
          aria-label={uiText('workspace:messageMoreActions')}
          title={uiText('workspace:messageMoreActions')}
          aria-expanded={popup === 'more'}
          aria-controls={popup === 'more' ? popupId : undefined}
          onClick={() => toggle('more')}
        >
          <Ellipsis size={16} aria-hidden="true" />
        </button>
      </div>
      {popup === 'reactions' && onReact && (
        <div
          key="reactions"
          className="message-action-panel message-reaction-panel"
          ref={panel}
          id={popupId}
          role="group"
          aria-label={uiText('common:text_cedae66a88ca')}
        >
          <ReactionChoices
            message={message}
            currentUserId={currentUserId}
            busy={busy}
            onClose={() => close(true)}
            onReact={(emoji, active) => {
              if (!enabled()) return;
              trigger()?.focus({ preventScroll: true });
              onReact(emoji, active);
            }}
          />
        </div>
      )}
      {popup === 'more' && (
        <div
          key="more"
          className="message-action-panel message-more-panel"
          ref={panel}
          id={popupId}
          role="group"
          aria-label={uiText('workspace:messageMoreActions')}
        >
          {onThread && (
            <button
              type="button"
              onClick={() => {
                if (close()) onThread();
              }}
            >
              <MessageSquare size={15} aria-hidden="true" />
              {uiText('workspace:threadReply')}
            </button>
          )}
          {copyText && (
            <button
              type="button"
              onClick={() => {
                if (close(true)) void copy(copyText);
              }}
            >
              <Copy size={15} aria-hidden="true" />
              {uiText('workspace:text_5d7fd21f1e3c')}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (close(true))
                void copy(
                  new URL(
                    conversationHref(message.conversationId, message.id),
                    window.location.origin,
                  ).href,
                );
            }}
          >
            <Link2 size={15} aria-hidden="true" />
            {uiText('workspace:messageCopyLink')}
          </button>
          {onJump && (
            <button
              type="button"
              onClick={() => {
                if (close(true)) onJump();
              }}
            >
              <CornerUpLeft size={15} aria-hidden="true" />
              {uiText('common:text_ae8b74945db0')}
            </button>
          )}
          <VoiceMessageButton
            voice={voice}
            message={message}
            showLabel
            onActivate={() => close(true)}
          />
        </div>
      )}
    </div>
  );
}
