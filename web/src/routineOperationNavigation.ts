import { uiText } from './i18n';
import type { Bootstrap } from '../../shared/types';
import type { RoutineOperationReceipt } from '../../shared/routine-operations';

/** Verify the original destination, without installing an unordered bootstrap snapshot. */
export function routineOperationDestination(snapshot: Bootstrap, receipt: RoutineOperationReceipt) {
  if (receipt.status === 'missing') throw Error(uiText('routines:text_92f0cb093833'));
  const conversation = snapshot.conversations.find((item) => item.id === receipt.conversationId);
  if (!conversation) throw Error(uiText('routines:text_4ef6829cd8af'));
  if (receipt.kind === 'create') {
    const routine = snapshot.routines.find((item) => item.id === receipt.routineId);
    if (
      !routine ||
      routine.conversationId !== receipt.conversationId ||
      routine.agentId !== receipt.agentId
    )
      throw Error(uiText('routines:text_ee1fe385ebc3'));
  } else {
    const input = snapshot.messages.find((item) => item.id === receipt.messageId);
    const marker = input?.metadata?.routineOperation as
      { requestId?: unknown; routineId?: unknown } | undefined;
    if (
      !input ||
      input.role !== 'user' ||
      input.userId !== receipt.userId ||
      input.conversationId !== receipt.conversationId ||
      input.delivery?.clientId !== receipt.requestId ||
      input.delivery.agentId !== receipt.agentId ||
      marker?.requestId !== receipt.requestId ||
      marker?.routineId !== receipt.routineId
    )
      throw Error(uiText('routines:text_d5327a555be6'));
  }
  return conversation;
}
