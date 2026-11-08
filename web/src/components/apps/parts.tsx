import { currentLanguage } from '../../i18n';
import { uiText } from '../../i18n';
import { ChevronRight } from 'lucide-react';
import { type ReactNode } from 'react';
import type { CustomAppProposalEntry } from '../../appProposalEntry';
import type { ConnectedApp } from '../../../../shared/app-connections';
import type { BotAgent } from '../../../../shared/types';
import type { PackagedSkillDraft } from '../../skillWorkflowTemplates';
import '../AppsDialog.css';
export type Props = {
  workspaceId?: string;
  userId?: string;
  workspaceName: string;
  team: boolean;
  canManage: boolean;
  computerConnected: boolean;
  modelLabel: string;
  modelConfigured: boolean;
  onFiles: () => void;
  onComputer: () => void;
  onSettings: () => void;
  onTemplates?: () => void;
  packagedSkills?: {
    bots: readonly Pick<BotAgent, 'id' | 'name'>[];
    onEdit: (draft: PackagedSkillDraft) => void;
  };
  onClose: () => void;
  onChanged?: () => void;
  sharedAgents?: BotAgent[];
  initialSharedBotId?: string;
  initialProviderId?: string;
  initialCustomProposal?: CustomAppProposalEntry;
};
export const blank = () => ({
  name: '',
  url: '',
  authType: 'none' as ConnectedApp['authType'],
  token: '',
  shared: false,
});
export const failed = (cause: unknown) =>
  cause instanceof Error ? cause.message : uiText('apps:text_adc105b477d6');
export const checked = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(currentLanguage(), {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai',
      }).format(new Date(value)) + uiText('apps:text_ea0a6f3c9485')
    : uiText('apps:text_cdbc0434f568');
export function EnvironmentLink({
  icon,
  title,
  text,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="apps-environment-link" onClick={onClick}>
      {icon}
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
      <ChevronRight size={14} />
    </button>
  );
}
