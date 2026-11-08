import { uiText } from './i18n';
import type { BotAgent, Conversation, Routine } from '../../shared/types';

export type RoutineChatRequest =
  | { kind: 'create'; conversationId: string; agentId: string }
  | { kind: 'edit'; conversationId: string; agentId: string; routineId: string };

/** Resolve only existing destinations; this prepares a draft and never starts a task. */
export function routineChatDestination(
  data: { agents: BotAgent[]; conversations: Conversation[]; routines: Routine[] },
  request: RoutineChatRequest,
) {
  if (!request || !['create', 'edit'].includes(request.kind))
    throw Error(uiText('routines:text_a7bc62882c4b'));
  const conversation = data.conversations.find((item) => item.id === request.conversationId),
    agent = data.agents.find((item) => item.id === request.agentId);
  if (!conversation || !agent || !conversation.agentIds.includes(agent.id))
    throw Error(uiText('routines:text_7dfe86dcf31a'));
  if (agent.sharedBot && agent.sharedBot.status !== 'active')
    throw Error(uiText('routines:text_37416e8dae17'));
  const routine =
    request.kind === 'edit'
      ? data.routines.find((item) => item.id === request.routineId)
      : undefined;
  if (
    request.kind === 'edit' &&
    (!routine || routine.conversationId !== conversation.id || routine.agentId !== agent.id)
  )
    throw Error(uiText('routines:text_8cf64a78298f'));
  return {
    conversation,
    agent,
    routine,
    text: routine
      ? uiText('routines:text_a6a4927cffcd', { value0: routine.title })
      : uiText('routines:text_e03220710216'),
  };
}
