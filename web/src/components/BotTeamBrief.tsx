import { uiText } from '../i18n';
import type { BotAgent, Conversation } from '../../../shared/types';
import './SmartTeamPanel.css';
export function BotTeamBrief({
  conversation,
  agents,
  onManage,
}: {
  conversation: Conversation;
  agents: BotAgent[];
  onManage?: () => void;
}) {
  const brief = conversation.teamBrief;
  if (!conversation.isGroup || !brief) return null;
  const members = conversation.agentIds.flatMap((id) => {
    const agent = agents.find((item) => item.id === id);
    return agent ? [agent] : [];
  });
  return (
    <section className="detail-section bot-team-brief">
      <div className="section-label">
        <span>{uiText('bots:text_e9b68157be27')}</span>
        {onManage && (
          <button type="button" className="text-button" onClick={onManage}>
            {uiText('bots:text_00d000bc3791')}
          </button>
        )}
      </div>
      <p className="section-help">
        {brief.goal.slice(0, 180)}
        {brief.goal.length > 180 ? '…' : ''}
      </p>
      <details>
        <summary>{uiText('bots:text_757062996aae')}</summary>
        {brief.goal.length > 180 && <p className="section-help">{brief.goal}</p>}
        <p className="section-help">{brief.summary}</p>
        <dl>
          {members.map((agent, index) => (
            <div key={agent.id}>
              <dt>
                {agent.name}
                {index === 0 && <span>{uiText('bots:text_a525346277ed')}</span>}
              </dt>
              <dd>
                {brief.assignments.find((item) => item.agentId === agent.id)?.assignment ||
                  uiText('bots:text_5f4dacc86942')}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
