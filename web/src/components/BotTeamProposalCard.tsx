import { serviceText } from '../i18n/serviceText';
import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Loader2, Users } from 'lucide-react';
import type { BotTeamProposalCard as Proposal } from '../../../shared/bot-team-plans';
import { createAppConnectionScope } from '../appConnections';
import { confirmTeamConversation, type ConfirmedTeamConversation } from '../botTeamDraft';
import './BotTeamProposalCard.css';
import { GROUP_MAX_MEMBERS } from '../../../shared/group-members';

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const string = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
export function parseBotTeamProposal(value: unknown): Proposal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const card = value as Proposal;
  if (
    !identifier(card.planId) ||
    !identifier(card.revision) ||
    !['generating', 'ready', 'committed', 'cancelled', 'error'].includes(card.status) ||
    !string(card.goal, 6000) ||
    !string(card.title, 100) ||
    !string(card.summary, 2000) ||
    !string(card.leadKey, 40) ||
    !Array.isArray(card.members) ||
    card.members.length > GROUP_MAX_MEMBERS ||
    (card.error !== undefined && !string(card.error, 2000))
  )
    return;
  const keys = new Set<string>();
  for (const member of card.members) {
    if (
      !member ||
      !identifier(member.key) ||
      keys.has(member.key) ||
      !['reuse', 'create'].includes(member.kind) ||
      !string(member.name, 40) ||
      !string(member.role, 80) ||
      !string(member.assignment, 2000) ||
      (member.agentId !== undefined && !identifier(member.agentId))
    )
      return;
    keys.add(member.key);
  }
  if (card.status === 'ready' && (!card.members.length || !keys.has(card.leadKey))) return;
  const result = card.result;
  if (result !== undefined && (!result || typeof result !== 'object' || Array.isArray(result)))
    return;
  if (
    result &&
    (!identifier(result.conversationId) ||
      !identifier(result.leadAgentId) ||
      !Array.isArray(result.memberAgentIds) ||
      !result.memberAgentIds.every(identifier) ||
      result.memberAgentIds.length > GROUP_MAX_MEMBERS ||
      !Array.isArray(result.createdAgentIds) ||
      !result.createdAgentIds.every(identifier) ||
      result.createdAgentIds.length > GROUP_MAX_MEMBERS)
  )
    return;
  return card;
}
const statusLabel = (status: Proposal['status']) =>
  ({
    generating: uiText('bots:text_7d414606ac86'),
    ready: uiText('bots:text_edb583ff5fd3'),
    committed: uiText('bots:text_d2b72840b2fe'),
    cancelled: uiText('bots:text_6364ff1851e2'),
    error: uiText('bots:text_2f371b60adc7'),
  })[status];
type Props = {
  proposal: Proposal;
  sourceName: string;
  sourceRemoved?: boolean;
  owner: boolean;
  scopeKey: string;
  workspaceId?: string;
  userId?: string;
  canOpenConversation: boolean;
  onOpenPlan: (id: string) => void;
  onOpenConversation: (confirmed: ConfirmedTeamConversation) => void;
};
export function BotTeamProposalCard(props: Props) {
  return <ProposalContent key={`${props.scopeKey}:${props.proposal.planId}`} {...props} />;
}
function ProposalContent(props: Props) {
  const [scope] = useState(() => createAppConnectionScope(props));
  const [opening, setOpening] = useState(false),
    [error, setError] = useState('');
  const running = useRef(false);
  const current = useRef(props),
    active = useRef(true);
  current.current = props;
  useEffect(() => {
    active.current = true;
    scope.resume();
    return () => {
      active.current = false;
      scope.suspend();
    };
  }, [scope]);
  const { proposal } = props;
  function openPlan() {
    const value = current.current;
    if (active.current && scope.current(scope.ticket()) && !running.current && value.owner)
      value.onOpenPlan(value.proposal.planId);
  }
  async function openConversation() {
    const value = current.current,
      ticket = scope.ticket();
    if (
      !active.current ||
      !scope.current(ticket) ||
      running.current ||
      !value.canOpenConversation ||
      value.proposal.status !== 'committed' ||
      !value.proposal.result
    )
      return;
    const id = value.proposal.result.conversationId;
    running.current = true;
    setOpening(true);
    setError('');
    try {
      const confirmed = await confirmTeamConversation(scope, id);
      if (
        !scope.current(ticket) ||
        !active.current ||
        current.current.proposal.result?.conversationId !== id ||
        current.current.proposal.status !== 'committed'
      )
        return;
      current.current.onOpenConversation(confirmed);
    } catch (cause) {
      if (scope.current(ticket)) setError((cause as Error).message);
    } finally {
      running.current = false;
      if (scope.current(ticket)) setOpening(false);
    }
  }
  return (
    <section
      className={`team-proposal-card team-proposal-${proposal.status}`}
      aria-label={uiText('bots:text_d27d3daad000')}
    >
      <header>
        <span className="team-proposal-icon">
          <Users size={16} />
        </span>
        <strong>{proposal.title || uiText('bots:text_d27d3daad000')}</strong>
        <span className="team-proposal-status">
          {proposal.status === 'generating' ? (
            <Loader2 size={12} className="spin" />
          ) : proposal.status === 'committed' ? (
            <Check size={12} />
          ) : null}
          {statusLabel(proposal.status)}
        </span>
      </header>
      <p className="team-proposal-source">
        {uiText('bots:proposedBy', { name: props.sourceName })}
        {props.sourceRemoved ? uiText('bots:text_73081d92caf5') : ''}
      </p>
      <p className="team-proposal-goal">
        {proposal.goal.slice(0, 220)}
        {proposal.goal.length > 220 ? '…' : ''}
      </p>
      {proposal.members.length > 0 && (
        <details>
          <summary>
            {uiText('bots:text_990195b963ee')}
            {proposal.members.length}
            {uiText('bots:text_e3ebd803ba04')}
          </summary>
          {proposal.goal.length > 220 && <p>{proposal.goal}</p>}
          <p>{proposal.summary}</p>
          <dl>
            {proposal.members.map((member) => (
              <div key={member.key}>
                <dt>
                  {member.name}
                  <span>
                    {member.key === proposal.leadKey
                      ? uiText('bots:text_a525346277ed')
                      : member.kind === 'create'
                        ? uiText('bots:text_56176e8781fa')
                        : uiText('bots:text_8b3c7b275399')}
                  </span>
                </dt>
                <dd>{member.assignment}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {proposal.error && (
        <p className="error-text" role="status">
          {serviceText(proposal.error)}
        </p>
      )}
      {proposal.status === 'ready' && (
        <p className="team-proposal-help">{uiText('bots:text_7a2c74457e97')}</p>
      )}
      {proposal.status === 'cancelled' && (
        <p className="team-proposal-help">{uiText('bots:text_ddb5db768587')}</p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="team-proposal-actions">
        {props.owner ? (
          <button type="button" className="secondary-button" disabled={opening} onClick={openPlan}>
            {proposal.status === 'ready'
              ? uiText('bots:text_7d8c5233c8d5')
              : uiText('bots:text_45e8ee82b3bb')}
            <ChevronRight size={14} />
          </button>
        ) : (
          <p className="team-proposal-help">
            {proposal.status === 'ready' || proposal.status === 'generating'
              ? uiText('bots:text_76d2fb2ab29e')
              : uiText('bots:text_695f38f22960')}
          </p>
        )}
        {proposal.status === 'committed' &&
          proposal.result &&
          (props.canOpenConversation ? (
            <button
              type="button"
              className="secondary-button"
              disabled={opening}
              onClick={() => void openConversation()}
            >
              {uiText('bots:text_87d97c064965')}
              <ChevronRight size={14} />
            </button>
          ) : (
            <p className="team-proposal-help">{uiText('bots:text_d58a894ee468')}</p>
          ))}
      </div>
    </section>
  );
}
