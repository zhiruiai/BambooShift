import type { Message } from '../../shared/types';
import { parseWebResearchMessage } from '../../shared/web-research';
import { dateKey } from './dates';

const clusterWindowMs = 5 * 60 * 1000;

function isAssistantText(message: Message) {
  return message.role === 'assistant' && (!message.kind || message.kind === 'text');
}

function isEmptyAssistantPlaceholder(message: Message) {
  return (
    isAssistantText(message) &&
    message.status !== 'error' &&
    !message.content.trim() &&
    !message.replyTo &&
    !message.reactions?.length &&
    !message.metadata?.botTemplate &&
    !message.metadata?.teamProposal &&
    !message.metadata?.primaryCheckIn &&
    !message.metadata?.appConnectionProposal
  );
}

function joins(first: Message | undefined, second: Message) {
  if (
    !first ||
    first.role !== second.role ||
    dateKey(first.createdAt) !== dateKey(second.createdAt)
  )
    return false;
  if (
    first.role === 'system' ||
    first.kind === 'activity' ||
    second.kind === 'activity' ||
    first.kind === 'web_research' ||
    second.kind === 'web_research'
  )
    return false;
  const elapsed = Date.parse(second.createdAt) - Date.parse(first.createdAt);
  if (!(elapsed >= 0 && elapsed <= clusterWindowMs)) return false;
  if (second.role === 'assistant') return !!first.agentId && first.agentId === second.agentId;
  return first.userId === second.userId;
}

export function chatTimeline(messages: readonly Message[], working: boolean) {
  // Use the raw tail so an unseen placeholder or handoff ends the previous text stream.
  const tail = messages.at(-1);
  const liveId =
    working &&
    tail &&
    isAssistantText(tail) &&
    tail.status === 'running' &&
    tail.metadata?.streamEnded !== true &&
    tail.content.trim()
      ? tail.id
      : undefined;
  const visible = messages.flatMap((message) => {
    const webResearch = parseWebResearchMessage(message);
    if (message.kind === 'web_research' ? !webResearch : isEmptyAssistantPlaceholder(message))
      return [];
    return [{ message, webResearch }];
  });
  const rows = visible.map(({ message, webResearch }, index) => {
    const previous = visible[index - 1]?.message;
    const next = visible[index + 1]?.message;
    return {
      message,
      webResearch,
      startsDay: !previous || dateKey(previous.createdAt) !== dateKey(message.createdAt),
      groupedWithPrevious: joins(previous, message),
      groupedWithNext: !!next && joins(message, next),
      streaming: message.id === liveId,
    };
  });
  return { rows, showWorking: working && !liveId };
}
