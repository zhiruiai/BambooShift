import type { RoutineConfigSnapshot } from './routine-operations';
import type { Routine } from './types';

export interface TransferRoutineRequest {
  requestId: string;
  expectedRoutine: RoutineConfigSnapshot;
  targetAgentId: string;
  targetConversationId: string;
}
export interface RoutineTransferReceipt {
  requestId: string;
  routineId: string;
  userId: string;
  workspaceId: string;
  sourceAgentId: string;
  sourceConversationId: string;
  targetAgentId: string;
  targetConversationId: string;
  appliedRevision: string;
  createdAt: string;
  status: 'transferred' | 'missing';
  routine?: Routine;
}
export type RoutineTransferResolution =
  | RoutineTransferReceipt
  | {
      requestId: string;
      userId: string;
      workspaceId: string;
      status: 'not_transferred';
    };
