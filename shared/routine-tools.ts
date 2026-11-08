export type RoutineToolName =
  'routine_list' | 'routine_create' | 'routine_update' | 'routine_pause' | 'routine_delete';

export interface RoutineToolListInput {
  routineId?: string;
}
export interface RoutineToolCreateInput {
  title: string;
  prompt: string;
  schedule: string;
  timeZone?: string;
  enabled?: boolean;
}
export interface RoutineToolUpdateInput {
  routineId: string;
  expectedRevision: string;
  changes: { title?: string; prompt?: string; schedule?: string; timeZone?: string };
}
export interface RoutineToolPauseInput {
  routineId: string;
  expectedRevision: string;
  paused: boolean;
}
export interface RoutineToolDeleteInput {
  routineId: string;
  expectedRevision: string;
}

export interface RoutineToolView {
  id: string;
  revision: string;
  conversationId: string;
  title: string;
  schedule: string;
  /** Effective task zone, including historical Shanghai for an absent saved field. */
  timeZone: string;
  configurationError?: 'invalid_time_zone';
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  prompt: string;
  promptTruncated: boolean;
}
export interface RoutineToolListResult {
  operation: 'list';
  defaultTimeZone: string;
  routines: RoutineToolView[];
  total: number;
  truncated: boolean;
}
export interface RoutineToolMutationResult {
  operation: 'create' | 'update' | 'pause' | 'delete';
  operationId: string;
  routineId: string;
  status: 'created' | 'updated' | 'paused' | 'resumed' | 'deleted';
  appliedAt: string;
  /** The configuration applied by this call; replay never rewrites a newer version. */
  routine?: RoutineToolView;
  notice: string;
}
export type RoutineToolResult = RoutineToolListResult | RoutineToolMutationResult;

/** Output bounds only, not a limit on saved routines or their execution frequency. */
export const ROUTINE_TOOL_LIST_LIMIT = 100;
export const ROUTINE_TOOL_OUTPUT_MAX_BYTES = 96 * 1024;
