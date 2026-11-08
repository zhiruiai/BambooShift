import type { BotAgent, Message } from '../../../shared/types';
import { uiText } from '../i18n';
import './ChatMentionStatus.css';

const deliveryLabels = {
  queued: 'workspace:composerMentionQueued',
  delivered: 'workspace:composerMentionDelivered',
  cancelled: 'workspace:composerMentionCancelled',
  interrupted: 'workspace:composerMentionInterrupted',
} as const;

export function ChatMentionStatus({ message, agents }: { message: Message; agents: BotAgent[] }) {
  const audience = message.mentions;
  if (message.role !== 'user' || !audience?.agentIds.length) return null;
  const name = (id: string) =>
    agents.find((agent) => agent.id === id)?.name || uiText('workspace:text_9260b658c908');
  const names = audience.agentIds.map(name).join(' · ');
  const targets = message.delivery?.mentionTargets;
  const label = audience.everyone
    ? `@everyone · ${names}`
    : uiText('workspace:composerMentionFor', { names });
  if (!targets?.length) return <p className="chat-mention-status">{label}</p>;
  return (
    <details className="chat-mention-status">
      <summary>{label}</summary>
      <ul>
        {targets.map((target) => (
          <li key={target.agentId}>
            <span>{name(target.agentId)}</span>
            <span>{uiText(deliveryLabels[target.state])}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
