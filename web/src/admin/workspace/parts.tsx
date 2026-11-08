import { uiText, localizedData } from '../../i18n';
import { Activity, Clock3, LayoutGrid, Monitor, ShieldCheck, Sparkles, Users } from 'lucide-react';
import '../Admin.css';
import { type AdminView } from '../AdminPanels';
export const sections = localizedData(
  () =>
    [
      { id: 'overview', label: uiText('platform:text_fea405f9b01d'), icon: LayoutGrid },
      { id: 'bots', label: uiText('platform:text_f20171122e23'), icon: Users },
      { id: 'records', label: uiText('platform:text_6e55e0f207bf'), icon: Activity },
      { id: 'models', label: uiText('platform:text_8cbcf741e727'), icon: Sparkles },
      { id: 'computer', label: uiText('platform:text_6205c8a9a2b9'), icon: Monitor },
      { id: 'automations', label: uiText('platform:text_95a7b04b3216'), icon: Clock3 },
      { id: 'access', label: uiText('platform:text_ba903aa19e03'), icon: ShieldCheck },
    ] as const,
);
export function initialView(): AdminView {
  const hash = window.location.hash.slice(1);
  return sections.find((section) => section.id === hash)?.id || 'overview';
}
export type AdminModal =
  | { kind: 'settings' }
  | { kind: 'computer' }
  | { kind: 'routine'; conversationId: string; routineId?: string }
  | { kind: 'skill'; id: string }
  | null;
