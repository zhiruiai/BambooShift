import type { Bootstrap } from '../../../shared/types';
import type { projectSidebar } from '../sidebarRoster';
import type { useWorkspaceController } from './useWorkspaceController';
export type Modal =
  | 'create'
  | 'primary'
  | 'settings'
  | 'apps'
  | 'memory'
  | 'routine'
  | 'routine-chat'
  | 'skills'
  | 'computer'
  | 'file-transfer'
  | 'agent'
  | 'group'
  | 'search'
  | 'search-file'
  | 'roster'
  | 'templates'
  | 'shared-bots'
  | 'sharing'
  | null;
export type DetailTab = 'details' | 'files' | 'computer' | 'members';
export type WorkspaceModel = Omit<ReturnType<typeof useWorkspaceController>, 'data' | 'sidebar'> & {
  data: Bootstrap;
  sidebar: ReturnType<typeof projectSidebar>;
};
