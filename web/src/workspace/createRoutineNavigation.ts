import { uiText } from '../i18n';
import type { MemoryImportReceipt } from '../../../shared/memory-imports';
import type { RoutineOperationReceipt } from '../../../shared/routine-operations';
import type { RoutineRun } from '../../../shared/routine-runs';
import { isSharedBot } from '../../../shared/shared-bots';
import type { Bootstrap } from '../../../shared/types';
import { type ComposerState } from '../chatDrafts';
import { routineChatDestination, type RoutineChatRequest } from '../routineChat';
import { routineOperationDestination } from '../routineOperationNavigation';
import { routineRunDestination } from '../routineRunNavigation';
import type { RoutineNavigationContext } from './createRoutineNavigation.types';
export function createRoutineNavigation(read: () => RoutineNavigationContext) {
  async function openRoutineOperation(receipt: RoutineOperationReceipt) {
    const { sendScope, currentUserId, sendIdentity, sync, refresh, openConversation, setModal } =
      read();

    const ticket = sendScope.ticket();
    if (
      !sendScope.current(ticket) ||
      receipt.userId !== currentUserId ||
      receipt.workspaceId !== sendIdentity.current.workspaceId
    )
      throw Error(uiText('workspace:text_47ec17cac233'));
    const snapshot = await sendScope.request<Bootstrap>('/bootstrap');
    if (!sendScope.current(ticket)) throw Error(uiText('workspace:text_47ec17cac233'));
    const destination = routineOperationDestination(snapshot, receipt);
    sync.written();
    void refresh();
    openConversation(destination);
    setModal(null);
  }
  async function openRoutineRun(run: RoutineRun) {
    const {
      sendScope,
      sync,
      refresh,
      openConversation,
      jumpRef,
      setPendingJump,
      nearBottom,
      setModal,
    } = read();

    const ticket = sendScope.ticket();
    if (!sendScope.current(ticket)) throw Error(uiText('workspace:text_08fb91737bef'));
    const snapshot = await sendScope.request<Bootstrap>('/bootstrap');
    if (!sendScope.current(ticket)) throw Error(uiText('workspace:text_08fb91737bef'));
    const destination = routineRunDestination(snapshot, run);
    sync.written();
    void refresh();
    openConversation(destination.conversation);
    jumpRef.current = {
      conversationId: destination.conversation.id,
      messageId: destination.messageId,
    };
    setPendingJump({ ...jumpRef.current, token: Date.now() });
    nearBottom.current = false;
    setModal(null);
  }
  async function openMemoryImport(receipt: MemoryImportReceipt) {
    const {
      sendScope,
      currentUserId,
      sendIdentity,
      sync,
      refresh,
      openConversation,
      setModal,
      setToast,
    } = read();

    const ticket = sendScope.ticket();
    if (
      !sendScope.current(ticket) ||
      receipt.userId !== currentUserId ||
      receipt.workspaceId !== sendIdentity.current.workspaceId
    )
      throw new Error(uiText('workspace:text_6b5e40231451'));
    if (receipt.status === 'missing') throw new Error(uiText('workspace:text_dc834bf33b5b'));
    const snapshot = await sendScope.request<Bootstrap>('/bootstrap');
    if (!sendScope.current(ticket)) throw new Error(uiText('workspace:text_6b5e40231451'));
    const conversation = snapshot.conversations.find(
      (item) =>
        item.id === receipt.conversationId &&
        !item.isGroup &&
        item.agentIds.length === 1 &&
        item.agentIds[0] === receipt.agentId,
    );
    const agent = snapshot.agents.find((item) => item.id === receipt.agentId);
    const input = snapshot.messages.find((item) => item.id === receipt.messageId);
    const marker = input?.metadata?.memoryImport as { id?: unknown } | undefined;
    if (
      !conversation ||
      !agent ||
      isSharedBot(agent) ||
      !input ||
      input.role !== 'user' ||
      input.userId !== receipt.userId ||
      input.conversationId !== receipt.conversationId ||
      input.delivery?.clientId !== receipt.requestId ||
      input.delivery.agentId !== receipt.agentId ||
      marker?.id !== receipt.requestId
    )
      throw new Error(uiText('workspace:text_b1dc0e9cf260'));
    // This fetch verifies the destination only. The sync controller owns
    // snapshot ordering, so a late verification must not overwrite newer SSE.
    sync.written();
    void refresh();
    openConversation(conversation);
    setModal(null);
    setToast(uiText('workspace:text_bfbbbbf01dc8'));
  }
  async function openRoutineChat(request: RoutineChatRequest, confirmedDraft?: ComposerState) {
    const {
      sendScope,
      canManageRef,
      sendingRef,
      uploadingRef,
      receipts,
      routineChatInput,
      compositionRef,
      pendingDictation,
      routineChatOpening,
      composersRef,
      emptyDraft,
      setRoutineChatBusy,
      setRoutineChatError,
      setRoutineChatPending,
      setModal,
      updateComposer,
      sync,
      refresh,
      routineChatFocus,
      openConversation,
      setToast,
    } = read();

    const ticket = sendScope.ticket();
    const allowed = () =>
      sendScope.current(ticket) &&
      canManageRef.current &&
      !sendingRef.current.size &&
      !uploadingRef.current.size &&
      !receipts.pending() &&
      !routineChatInput.current.dictationBusy &&
      !compositionRef.current &&
      !pendingDictation.current;
    if (!allowed() || routineChatOpening.current)
      throw Error(uiText('workspace:text_26f0f837104f'));
    const original = composersRef.current[request.conversationId] || emptyDraft.current;
    if (confirmedDraft && original !== confirmedDraft)
      throw Error(uiText('workspace:text_8769786ca942'));
    routineChatOpening.current = true;
    setRoutineChatBusy(true);
    try {
      const snapshot = await sendScope.request<Bootstrap>('/bootstrap');
      if (!allowed()) throw Error(uiText('workspace:text_83e0d1f6063f'));
      const destination = routineChatDestination(snapshot, request);
      if ((composersRef.current[request.conversationId] || emptyDraft.current) !== original)
        throw Error(uiText('workspace:text_8769786ca942'));
      if (
        !confirmedDraft &&
        (original.text ||
          original.attachments.length ||
          original.replyTo ||
          original.agentId ||
          original.appContext)
      ) {
        setRoutineChatError('');
        setRoutineChatPending({ request, draft: original, agentName: destination.agent.name });
        setModal('routine-chat');
        return;
      }
      const text = original.text ? `${original.text}\n\n${destination.text}` : destination.text;
      if (text.length > 30000) throw Error(uiText('workspace:text_f042dfb3b24e'));
      updateComposer(destination.conversation.id, (previous) => ({
        ...previous,
        text,
        agentId: destination.agent.id,
      }));
      // Destination verification must not replace a newer SSE snapshot.
      sync.written();
      void refresh();
      routineChatFocus.current = destination.conversation.id;
      openConversation(destination.conversation);
      setRoutineChatPending(undefined);
      setModal(null);
      setToast(uiText('workspace:text_f4fdbe796172', { value0: destination.agent.name }));
    } finally {
      routineChatOpening.current = false;
      if (sendScope.current(ticket)) setRoutineChatBusy(false);
    }
  }
  return { openRoutineOperation, openRoutineRun, openMemoryImport, openRoutineChat };
}
