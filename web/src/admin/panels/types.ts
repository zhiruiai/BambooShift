import type { AdminOverview } from '../../../../shared/admin';
import type { Bootstrap, Routine, Skill } from '../../../../shared/types';
export { conversationHref } from '../../workspace-scope';
export type AdminView =
  'overview' | 'bots' | 'records' | 'models' | 'computer' | 'automations' | 'access';
export interface AdminPanelProps {
  overview: AdminOverview;
  data: Bootstrap;
  busy: boolean;
  conversationId: string;
  onConversationChange: (id: string) => void;
  onView: (view: AdminView) => void;
  onModels: () => void;
  onComputer: () => void;
  onRoutine: (routine?: Routine) => void;
  onSkill: (skill: Skill) => void;
  onStop: (conversationId: string) => void;
  canStop: (conversationId: string) => boolean;
}
