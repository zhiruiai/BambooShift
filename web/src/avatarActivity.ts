import type { ApprovalActor } from '../../shared/approvals';
import { parseChatQuestion } from '../../shared/chat-questions';
import type { Bootstrap, Message } from '../../shared/types';
import { parseAppAction } from './components/AppActionCard';
import type { AvatarMotion } from './components/Avatar';
import { remoteShellResultStatus } from './components/RemoteShellDetails';
import {
  computerActionFullyAuthorized,
  computerActionNeedsApproval,
  mayDecideComputerAction,
  parseChatComputerAction,
} from './components/computer/chatApproval';

export function messageAvatarMotion(
  message: Message,
  streaming: boolean,
  actor: ApprovalActor,
): AvatarMotion | undefined {
  if (message.kind === 'question' && message.status === 'done' && message.agentId) {
    const question = parseChatQuestion(message.metadata?.question);
    return question?.status === 'pending' ? 'attention' : undefined;
  }
  if (message.kind === 'computer') {
    const action = parseChatComputerAction(message.metadata?.action);
    if (mayDecideComputerAction(message, action, actor)) return 'attention';
    if (action?.status === 'pending')
      return computerActionFullyAuthorized(action) || !computerActionNeedsApproval(action.type)
        ? 'working'
        : 'attention';
    if (action?.status === 'running') return 'working';
    if (action?.status === 'error') return 'error';
    if (action?.status !== 'done') return;
    if (['local_shell', 'remote_shell', 'local_skill_script'].includes(action.type)) {
      const outcome = remoteShellResultStatus(action.result)?.kind;
      return outcome === 'done' || outcome === 'error' ? outcome : undefined;
    }
    return 'done';
  }
  if (message.kind === 'approval') {
    const action = parseAppAction(message.metadata?.appAction);
    if (
      action?.status === 'pending' &&
      action.agentId === message.agentId &&
      action.conversationId === message.conversationId
    )
      return 'attention';
    if (action?.status === 'running') return 'working';
    if (action?.status === 'error' || (action?.status === 'done' && action.result?.isError))
      return 'error';
    return action?.status === 'done' ? 'done' : undefined;
  }
  if (streaming) return 'working';
  if (
    (!message.kind || message.kind === 'text') &&
    message.status === 'running' &&
    message.metadata?.streamEnded === true &&
    !!message.content.trim()
  )
    return 'thinking';
  if (message.status === 'error') return 'error';
  return message.status === 'done' ? 'done' : undefined;
}

/** Keep old unfinished receipts still, without treating a queued follow-up as a new run. */
export function activeAvatarMessageIds(
  messages: readonly Message[],
  requests?: Bootstrap['runningRequests'],
): ReadonlySet<string> {
  const scope = (value: { conversationId: string; threadRootId?: string }) =>
    `${value.conversationId}:${value.threadRootId || ''}`;
  const starts = new Map<string, number>();
  const anchors = new Map<string, number>();
  const conversations = new Set(messages.map((message) => message.conversationId));
  const runs = requests?.filter((run) => conversations.has(run.conversationId));
  const runningScopes = new Set(runs?.map(scope));
  messages.forEach((message, index) => {
    if (message.role === 'user' && message.delivery?.state !== 'queued')
      starts.set(scope(message), index);
  });
  for (const run of runs || []) {
    const index = messages.findIndex((message) => message.id === run.requester?.messageId);
    if (index >= 0) anchors.set(scope(run), Math.min(anchors.get(scope(run)) ?? index, index));
  }
  return new Set(
    messages
      .filter((message, index) => {
        const key = scope(message);
        return (
          (!runs?.length || runningScopes.has(key)) &&
          index >= (anchors.get(key) ?? starts.get(key) ?? 0)
        );
      })
      .map((message) => message.id),
  );
}

/** Read current execution signals, not the last completed result or the Bot's global status. */
export function conversationAvatarActivity(
  messages: readonly Message[],
  working: boolean,
  actor: ApprovalActor,
  requests?: Bootstrap['runningRequests'],
): { motion: AvatarMotion; agentId?: string } {
  const latest = messages.findLast(
    (message) =>
      message.role === 'user' ||
      (message.role === 'assistant' &&
        message.kind !== 'activity' &&
        message.kind !== 'web_research'),
  );
  if (!working) {
    const outcome = latest?.role === 'assistant' && messageAvatarMotion(latest, false, actor);
    return {
      motion: outcome === 'done' || outcome === 'error' ? outcome : 'idle',
      agentId: latest?.agentId,
    };
  }
  const active = activeAvatarMessageIds(messages, requests);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!active.has(message.id) || message.role !== 'assistant' || !message.agentId) continue;
    const streaming =
      message.status === 'running' &&
      message.metadata?.streamEnded !== true &&
      !!message.content.trim() &&
      (!message.kind || message.kind === 'text');
    const motion = messageAvatarMotion(message, streaming, actor);
    if (motion === 'working' || motion === 'attention' || motion === 'thinking')
      return { motion, agentId: message.agentId };
    if (message.status === 'running') return { motion: 'thinking', agentId: message.agentId };
  }
  const lastWorker = messages.findLast(
    (message) => active.has(message.id) && message.role === 'assistant' && message.agentId,
  );
  const request = messages.findLast((message) => active.has(message.id) && message.role === 'user');
  const queued = request?.delivery?.state === 'queued' ? request : undefined;
  return { motion: 'thinking', agentId: lastWorker?.agentId || queued?.delivery?.agentId };
}
