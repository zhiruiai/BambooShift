import type { WorkspaceSummary } from '../../../../shared/platform';
import { type ConfirmedSharedBot } from '../../sharedBots';
import '../SharedBots.css';
export type BrowseProps = {
  userId: string;
  personalWorkspace?: WorkspaceSummary;
  teams: WorkspaceSummary[];
  initialTeamId?: string;
  shareId?: string;
  onClose: () => void;
  onOpen: (value: ConfirmedSharedBot) => void;
};
export type ManageProps = {
  userId: string;
  workspaceId: string;
  workspaceKind?: string;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
};
