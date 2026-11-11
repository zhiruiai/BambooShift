import { canDecideAction, type ApprovalActor } from '../../../shared/approvals';
import { parseChatQuestion } from '../../../shared/chat-questions';
import type { BotAgent, Message } from '../../../shared/types';
import { parseAppAction } from '../components/AppActionCard';
import { Avatar, type AvatarMotion } from '../components/Avatar';
import {
  mayDecideComputerAction,
  parseChatComputerAction,
} from '../components/computer/chatApproval';
import { uiText } from '../i18n';

export function messageAvatarMotion(
  message: Message,
  streaming: boolean,
  actor: ApprovalActor,
): AvatarMotion | undefined {
  if (message.kind === 'question' && message.status === 'done' && message.agentId) {
    const question = parseChatQuestion(message.metadata?.question);
    return question?.status === 'pending' && question.requester.userId === actor.userId
      ? 'attention'
      : undefined;
  }
  if (message.kind === 'computer') {
    const action = parseChatComputerAction(message.metadata?.action);
    if (mayDecideComputerAction(message, action, actor)) return 'attention';
    if (action?.status === 'running') return 'working';
    return action?.status === 'done' ? 'done' : undefined;
  }
  if (message.kind === 'approval') {
    const action = parseAppAction(message.metadata?.appAction);
    if (
      action?.status === 'pending' &&
      action.agentId === message.agentId &&
      action.conversationId === message.conversationId &&
      canDecideAction(action.requester, actor)
    )
      return 'attention';
    if (action?.status === 'running') return 'working';
    return action?.status === 'done' && !action.result?.isError ? 'done' : undefined;
  }
  if (streaming) return 'working';
  return message.status === 'done' ? 'done' : undefined;
}

export function ChatMessageAvatar({
  message,
  agent,
  actor,
  streaming,
  grouped,
  teammate,
}: {
  message: Message;
  agent?: Partial<BotAgent>;
  actor: ApprovalActor;
  streaming: boolean;
  grouped: boolean;
  teammate?: string;
}) {
  return (
    <div className="message-avatar">
      {!grouped && message.role === 'assistant' && (
        <Avatar
          agent={agent}
          size={23}
          motion={messageAvatarMotion(message, streaming, actor)}
          awaitingCompletion={
            (!message.kind || message.kind === 'text') &&
            message.status === 'running' &&
            message.metadata?.streamEnded === true
          }
        />
      )}
      {!grouped && teammate !== undefined && (
        <span className="user-avatar teammate-avatar">{Array.from(teammate)[0]}</span>
      )}
    </div>
  );
}

export function ChatWorkingAvatar({
  agent,
  last,
  actor,
}: {
  agent?: BotAgent;
  last?: Message;
  actor: ApprovalActor;
}) {
  const motion = last?.role === 'assistant' ? messageAvatarMotion(last, false, actor) : undefined;
  if (motion === 'attention' || motion === 'working') return null;
  return (
    <div className="working-line" role="status">
      <Avatar key={agent?.id} agent={agent} size={22} motion="working" />
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>
        {agent
          ? uiText('workspace:timelineWorker', { name: agent.name })
          : uiText('workspace:text_e556fe53f2b0')}
      </span>
    </div>
  );
}
