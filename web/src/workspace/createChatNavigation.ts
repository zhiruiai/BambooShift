import { uiText } from '../i18n';
import type { Conversation, Message } from '../../../shared/types';
import { historicalAuthor } from '../messageAuthors';
import { composerScopeKey } from '../chatDrafts';
import type { ChatNavigationContext } from './createChatNavigation.types';
export function createChatNavigation(read: () => ChatNavigationContext) {
  function showChat(conversationId: string) {
    const { mobileNavigation, setMobileChat } = read();

    if (!mobileNavigation.current?.move({ view: 'chat', conversationId })) {
      setMobileChat(true);
    }
  }
  function toggleDetails(open = !read().showDetail) {
    const { showDetail, mobileNavigation, selected, setShowDetail } = read();

    if (
      !mobileNavigation.current?.move({ view: open ? 'details' : 'chat', conversationId: selected })
    ) {
      setShowDetail(open);
    }
  }
  function showConversationList() {
    const { mobileNavigation, setMobileChat, setShowDetail, selected, setOpenThread } = read();
    setOpenThread?.(selected);

    if (!mobileNavigation.current?.move({ view: 'home' })) {
      setMobileChat(false);
      setShowDetail(false);
    }
  }
  function openConversation(c: Conversation) {
    const {
      jumpRef,
      setPendingJump,
      setHighlightedMessage,
      selectedRef,
      setSelected,
      setMenuOpen,
      setOpenThread,
    } = read();

    setOpenThread?.(c.id);
    jumpRef.current = null;
    setPendingJump(null);
    setHighlightedMessage('');
    selectedRef.current = c.id;
    setSelected(c.id);
    showChat(c.id);
    setMenuOpen(false);
  }
  function jumpToMessage(conversationId: string, messageId?: string, closeThread = false) {
    const {
      data,
      setToast,
      jumpRef,
      setHighlightedMessage,
      setPendingJump,
      nearBottom,
      selectedRef,
      setSelected,
      setShowDetail,
      setMenuOpen,
      setReactionPicker,
      setModal,
      threadRootId,
      setOpenThread,
    } = read();

    if (!data?.conversations.some((c) => c.id === conversationId)) {
      setToast(uiText('workspace:text_956d7bbe90b3'));
      return;
    }
    const message = messageId
      ? data.messages.find((m) => m.id === messageId && m.conversationId === conversationId)
      : undefined;
    if (messageId && !message) {
      setToast(uiText('workspace:text_5e6ad8b0744a'));
      return;
    }
    setOpenThread?.(
      conversationId,
      closeThread
        ? undefined
        : message?.threadRootId || (message?.id === threadRootId ? threadRootId : undefined),
    );
    jumpRef.current = messageId ? { conversationId, messageId } : null;
    setHighlightedMessage('');
    setPendingJump(messageId ? { conversationId, messageId, token: Date.now() } : null);
    nearBottom.current = !messageId;
    selectedRef.current = conversationId;
    setSelected(conversationId);
    showChat(conversationId);
    if (window.innerWidth <= 1150) setShowDetail(false);
    setMenuOpen(false);
    setReactionPicker(null);
    setModal(null);
  }
  function beginReply(message: Message) {
    const { userName, data, updateComposer, setReactionPicker, composerRef, threadRootId } = read();

    const author =
      message.role === 'user'
        ? userName(message)
        : data?.agents.find((a) => a.id === message.agentId)?.name ||
          historicalAuthor(message)?.name ||
          uiText('workspace:text_0583e9855b7b');
    updateComposer(composerScopeKey(message.conversationId, threadRootId), (previous) => ({
      ...previous,
      replyTo: {
        id: message.id,
        agentId: message.role === 'assistant' ? message.agentId : undefined,
        author,
        content: message.content.slice(0, 800),
        kind: message.kind,
      },
    }));
    setReactionPicker(null);
    composerRef.current?.focus();
  }
  function openThread(message: Message) {
    const {
      setOpenThread,
      selected,
      data,
      jumpRef,
      setPendingJump,
      setHighlightedMessage,
      setReactionPicker,
      nearBottom,
      composerRef,
      selectedRef,
    } = read();
    const rootId = message.threadRootId || message.id;
    if (
      message.conversationId !== selected ||
      !data?.messages.some(
        (item) =>
          item.id === rootId &&
          item.conversationId === selected &&
          item.role !== 'system' &&
          item.kind !== 'activity' &&
          !item.threadRootId,
      )
    )
      return;
    jumpRef.current = null;
    nearBottom.current = true;
    setPendingJump(null);
    setHighlightedMessage('');
    setReactionPicker(null);
    setOpenThread?.(selected, rootId);
    window.requestAnimationFrame(() => {
      const field = composerRef.current;
      if (selectedRef.current === selected && field?.dataset.threadRootId === rootId)
        field.focus({ preventScroll: true });
    });
  }
  function closeThread() {
    const { selected, threadRootId } = read();
    if (threadRootId) jumpToMessage(selected, threadRootId, true);
  }
  return {
    showChat,
    toggleDetails,
    showConversationList,
    openConversation,
    jumpToMessage,
    beginReply,
    openThread,
    closeThread,
  };
}
