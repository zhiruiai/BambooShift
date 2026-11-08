import { uiText } from './i18n';
import type { Bootstrap } from '../../shared/types';
import type { RoutineRun } from '../../shared/routine-runs';

/** Verify the original history destination without installing an unordered snapshot. */
export function routineRunDestination(snapshot: Bootstrap, run: RoutineRun) {
  const conversation = snapshot.conversations.find((item) => item.id === run.conversationId);
  const messageId = run.resultMessageId || run.inputMessageId;
  const message = snapshot.messages.find((item) => item.id === messageId);
  const marker = message?.metadata?.routineRun as
    { runId?: unknown; routineId?: unknown; inputMessageId?: unknown } | undefined;
  if (
    !conversation ||
    !message ||
    message.conversationId !== conversation.id ||
    marker?.runId !== run.runId ||
    marker.routineId !== run.routineId ||
    typeof marker.inputMessageId !== 'string' ||
    (run.inputMessageId && marker.inputMessageId !== run.inputMessageId)
  )
    throw Error(uiText('routines:text_f081f45c8c30'));
  if (run.resultMessageId) {
    if (message.role !== 'assistant' || message.agentId !== run.agentId)
      throw Error(uiText('routines:text_9449b0b15dd6'));
  } else if (
    message.id !== marker.inputMessageId ||
    !(
      (message.role === 'user' && message.delivery?.agentId === run.agentId) ||
      (message.role === 'system' && message.agentId === run.agentId)
    )
  )
    throw Error(uiText('routines:text_d07d07672cd7'));
  return { conversation, messageId: message.id };
}
