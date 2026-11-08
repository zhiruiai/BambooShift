export const ROUTINE_RUN_HISTORY_LIMIT = 20;

/** Only actual runs admitted since history tracking was enabled are included. */
export interface RoutineRun {
  runId: string;
  routineId: string;
  agentId: string;
  conversationId: string;
  inputMessageId?: string;
  resultMessageId?: string;
  trigger: 'scheduled' | 'manual' | 'webhook';
  /** Running includes accepted work preparing its model session. */
  status: 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  /** A fixed, safe explanation; never raw model/provider errors. */
  error?: string;
}

export interface RoutineRunHistory {
  routineId: string;
  runs: RoutineRun[];
}
