import type { Routine } from './types.js';

export type RoutineConfigSnapshot = Pick<
  Routine,
  | 'agentId'
  | 'conversationId'
  | 'title'
  | 'prompt'
  | 'schedule'
  | 'timeZone'
  | 'enabled'
  | 'publicSearchQueries'
>;

/** The exact editable configuration the person saw, excluding execution timestamps. */
export function routineConfigSnapshot(routine: RoutineConfigSnapshot): RoutineConfigSnapshot {
  return {
    agentId: routine.agentId,
    conversationId: routine.conversationId,
    title: routine.title,
    prompt: routine.prompt,
    schedule: routine.schedule,
    ...(routine.timeZone !== undefined ? { timeZone: routine.timeZone } : {}),
    enabled: routine.enabled,
    ...(routine.publicSearchQueries?.length
      ? { publicSearchQueries: [...routine.publicSearchQueries] }
      : {}),
  };
}

export interface CreateRoutineRequest {
  requestId: string;
  agentId: string;
  conversationId?: string;
  title: string;
  prompt: string;
  schedule?: string;
  timeZone?: string;
  enabled?: boolean;
  publicSearchQueries?: string[];
}
export interface RunRoutineRequest {
  requestId: string;
  expectedRoutine: RoutineConfigSnapshot;
}
export type RoutineOperationRequest =
  | ({ kind: 'create' } & CreateRoutineRequest)
  | ({ kind: 'run'; routineId: string } & RunRoutineRequest);

export type RoutineRunStatus = 'completed' | 'error' | 'cancelled' | 'interrupted';
interface RoutineOperationBase {
  requestId: string;
  routineId: string;
  agentId: string;
  conversationId: string;
  createdAt: string;
  userId?: string;
  workspaceId?: string;
}
export type RoutineOperationReceipt =
  | (RoutineOperationBase & { kind: 'create'; status: 'created' | 'missing' })
  | (RoutineOperationBase & {
      kind: 'run';
      status: 'submitted' | RoutineRunStatus | 'missing';
      messageId: string;
      nextRunAt: string;
      resultMessageId?: string;
    });

/** Closing an unaccepted request never cancels work already admitted by the server. */
export type RoutineOperationResolution =
  | RoutineOperationReceipt
  | { requestId: string; status: 'not_submitted'; userId?: string; workspaceId?: string };
