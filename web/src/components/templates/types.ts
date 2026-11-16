import { type ConfirmedBotInstall, type TemplateScope } from '../../botTemplates';
import type { SmartTeamProps } from '../team/types';
import '../BotTemplates.css';
export type BotTemplateDialogRequest =
  | { kind: 'copy' | 'share'; agentId: string; conversationId: string }
  | { kind: 'manage'; templateId: string }
  | { kind: 'library' };
export type Props = {
  request: BotTemplateDialogRequest;
  workspaceId?: string;
  userId?: string;
  owner: boolean;
  team: boolean;
  onClose: () => void;
  onCreated: (value: ConfirmedBotInstall) => void;
  onChanged: () => void;
  onOpenPublic: (path: string) => void;
  teamTemplates?: Pick<SmartTeamProps, 'agents' | 'modelConfigured' | 'modelLabel' | 'onCreated'>;
};
export type Common = Props & {
  scope: TemplateScope;
  onBack: () => void;
  onManage: (id: string) => void;
};
export type PendingEdit = { method: 'POST' | 'PATCH'; path: string; body: Record<string, unknown> };
