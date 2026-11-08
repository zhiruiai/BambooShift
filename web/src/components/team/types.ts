import { uiText } from '../../i18n';
import type { BotTeamPlan } from '../../../../shared/bot-team-plans';
import type { BotAgent } from '../../../../shared/types';
import { type ConfirmedTeamConversation } from '../../botTeamDraft';
import '../SmartTeamPanel.css';
import type { useSmartTeam } from './useSmartTeam';
export type SmartTeamProps = {
  agents: BotAgent[];
  workspaceId?: string;
  userId?: string;
  modelConfigured: boolean;
  modelLabel: string;
  initialPlanId?: string;
  disabled?: boolean;
  onConfigureModel?: () => void;
  onBusy: (busy: boolean) => void;
  onDirty: (dirty: boolean) => void;
  onCreated: (plan: BotTeamPlan, start: boolean, confirmed: ConfirmedTeamConversation) => void;
};
export type SmartTeamModel = ReturnType<typeof useSmartTeam>;
export const label = (status: BotTeamPlan['status']) =>
  ({
    generating: uiText('bots:text_7d414606ac86'),
    ready: uiText('bots:text_a8b0bd9c65f7'),
    error: uiText('bots:text_554707d96341'),
    cancelled: uiText('bots:text_a37778f17c5f'),
    committed: uiText('bots:text_80bfa30db209'),
  })[status];
