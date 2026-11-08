import { uiText, localizedData } from '../../../web/src/i18n';
import { Building2, LayoutGrid, Users } from 'lucide-react';
import type { AccountStatus } from '../../../shared/platform';
import '../../../web/src/admin/Admin.css';
import '../../../web/src/platform/Platform.css';
export type View = 'overview' | 'users' | 'workspaces';
export type StatusTarget = {
  kind: 'users' | 'workspaces';
  id: string;
  name: string;
  status: AccountStatus;
};
export const views = localizedData(
  () =>
    [
      { id: 'overview', label: uiText('platform:text_cf2b56d279e6'), icon: LayoutGrid },
      { id: 'users', label: uiText('platform:text_fbf413d429bd'), icon: Users },
      { id: 'workspaces', label: uiText('platform:text_b4bdf646aa3e'), icon: Building2 },
    ] as const,
);
