import type { Message } from '../../shared/types';
import { parseWebResearchMessage } from '../../shared/web-research';
import { dateKey, validDate } from './dates';

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

type TimelineEntry = {
  message: Message;
  webResearch: ReturnType<typeof parseWebResearchMessage>;
  day: string;
  at: number;
};
function joins(first: TimelineEntry, second: TimelineEntry) {
  const left = first.message;
  const right = second.message;
  if (
    left.role !== right.role ||
    first.day !== second.day ||
    left.role === 'system' ||
    left.kind === 'activity' ||
    right.kind === 'activity' ||
    left.kind === 'web_research' ||
    right.kind === 'web_research'
  )
    return false;
  const elapsed = second.at - first.at;
  if (!(elapsed >= 0 && elapsed <= clusterWindowMs)) return false;
  if (right.role === 'assistant') return !!left.agentId && left.agentId === right.agentId;
  return left.userId === right.userId;
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
  const rows: Array<
    Pick<TimelineEntry, 'message' | 'webResearch'> & {
      startsDay: boolean;
      groupedWithPrevious: boolean;
      groupedWithNext: boolean;
      streaming: boolean;
    }
  > = [];
  let previous: TimelineEntry | undefined;
  for (const message of messages) {
    const webResearch = parseWebResearchMessage(message);
    if (message.kind === 'web_research' ? !webResearch : isEmptyAssistantPlaceholder(message))
      continue;
    const date = validDate(message.createdAt);
    const day = date ? dateKey(date) : 'unknown';
    const entry = { message, webResearch, day, at: date?.getTime() ?? NaN };
    const groupedWithPrevious = !!previous && joins(previous, entry);
    const previousRow = rows.at(-1);
    if (previousRow) previousRow.groupedWithNext = groupedWithPrevious;
    rows.push({
      message,
      webResearch,
      startsDay: previous?.day !== day,
      groupedWithPrevious,
      groupedWithNext: false,
      streaming: message.id === liveId,
    });
    previous = entry;
  }
  return { rows, showWorking: working && !liveId };
}
