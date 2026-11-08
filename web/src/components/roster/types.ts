import { type SidebarTarget } from '../../../../shared/sidebar-roster';
import type { Bootstrap, Conversation } from '../../../../shared/types';
import type { SidebarRosterController } from '../../useSidebarRoster';
import '../SidebarRoster.css';
export type RosterDialogRequest =
  | { kind: 'hidden' }
  | { kind: 'create'; target?: SidebarTarget }
  | { kind: 'rename'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'move'; target: SidebarTarget };
export type MenuAction = { label: string; action: () => void; disabled?: boolean };
export type ListProps = {
  data: Bootstrap;
  query: string;
  mobile: boolean;
  selected: string;
  now: number;
  roster: SidebarRosterController;
  onOpen: (conversation: Conversation) => void;
  working: (id: string) => boolean;
  onDialog: (request: RosterDialogRequest) => void;
  onPrimary: () => void;
  onNotice: (notice: string) => void;
};
export type DialogProps = {
  request: RosterDialogRequest;
  data: Bootstrap;
  roster: SidebarRosterController;
  workspaceId?: string;
  userId?: string;
  onClose: () => void;
  onOpen: (conversation: Conversation) => void;
  onNotice: (notice: string) => void;
  onPrimary: () => void;
};
