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
/** Safe terminal explanations shared by the runtime and persistent run history. */
export const ROUTINE_RUN_ERRORS = {
  interrupted: '运行中断，未自动重试。',
  cancelled: '本次运行已停止，已执行的操作不会自动撤回。',
  access: '账户或 Bot 的访问权限已失效，本次运行已停止。',
  notStarted: '本次运行未能启动，请检查 Bot、聊天和访问权限。',
  modelNotConfigured: '尚未配置模型服务，请配置后明确重新运行。',
  modelUnavailable: '模型当前不可用，请检查模型配置后重新运行。',
  failed: '本次运行未能完成，请打开原对话查看详情。',
  cleanup: '电脑操作的清理状态尚未确认，请先检查执行电脑。',
} as const;
export interface RoutineRunOutcome {
  status: RoutineRunStatus;
  resultMessageId?: string;
  error?: string;
}
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
