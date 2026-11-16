import { ArrowDown, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  mayAllowComputerAction,
  mayDecideComputerAction,
  parseChatComputerAction,
} from '../components/computer/chatApproval';
import { uiText } from '../i18n';
import type { WorkspaceModel } from './types';

export function ChatJumpNotice({
  account,
  canManage,
  conversation,
  data,
  jumpToMessage,
  modal,
  nearBottom,
  scrollRef,
  sendScope,
  setHighlightedMessage,
  setUnreadBelow,
  threadRootId,
  unreadBelow,
}: Pick<
  WorkspaceModel,
  | 'account'
  | 'canManage'
  | 'conversation'
  | 'data'
  | 'jumpToMessage'
  | 'modal'
  | 'nearBottom'
  | 'scrollRef'
  | 'sendScope'
  | 'setHighlightedMessage'
  | 'setUnreadBelow'
  | 'threadRootId'
  | 'unreadBelow'
>) {
  const userId = account?.session.user?.id;
  const conversationId = conversation?.demo ? undefined : conversation?.id;
  const approval = useMemo(() => {
    if (!conversationId) return;
    const messages = data.messages;
    return messages?.findLast((message) => {
      if (message.conversationId !== conversationId || message.kind !== 'computer') return false;
      const action = parseChatComputerAction(message.metadata?.action);
      return (
        !!action &&
        mayDecideComputerAction(message, action, { userId, isOwner: canManage }) &&
        mayAllowComputerAction(action) &&
        (!message.threadRootId ||
          messages.some(
            (root) =>
              root.id === message.threadRootId &&
              root.conversationId === conversationId &&
              !root.threadRootId,
          ))
      );
    });
  }, [canManage, conversationId, data.messages, userId]);
  const viewKey = JSON.stringify([userId, conversationId, threadRootId, approval?.id]);
  const inCurrentView =
    !!approval && (approval.threadRootId === threadRootId || approval.id === threadRootId);
  const [visibility, setVisibility] = useState<{ viewKey: string; visible: boolean }>();
  useEffect(() => {
    if (!approval || !inCurrentView || !scrollRef.current || !globalThis.IntersectionObserver)
      return;
    const card = document.getElementById(`message-${approval.id}`);
    const buttons = card?.querySelector('.chat-computer-approval-buttons');
    if (!buttons) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisibility({ viewKey, visible: entry.intersectionRatio >= 0.75 }),
      { root: scrollRef.current, threshold: 0.75 },
    );
    observer.observe(buttons);
    return () => observer.disconnect();
  }, [approval, inCurrentView, scrollRef, viewKey]);

  const hidden =
    !inCurrentView || (visibility?.viewKey === viewKey ? !visibility.visible : unreadBelow);
  const ticket = sendScope.ticket();
  if (approval && hidden && !modal)
    return (
      <button
        type="button"
        className="jump-bottom approval-jump"
        onClick={() => {
          if (sendScope.current(ticket))
            jumpToMessage(approval.conversationId, approval.id, !approval.threadRootId);
        }}
      >
        <ShieldCheck size={16} aria-hidden="true" />
        {uiText('workspace:computerApprovalJump')}
      </button>
    );
  return unreadBelow ? (
    <button
      type="button"
      className="jump-bottom"
      onClick={() => {
        setHighlightedMessage('');
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
        nearBottom.current = true;
        setUnreadBelow(false);
      }}
    >
      <ArrowDown size={16} aria-hidden="true" />
      {uiText('workspace:text_d34db9bc67fb')}
    </button>
  ) : null;
}
