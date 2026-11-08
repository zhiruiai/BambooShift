import type { PrimaryBotState } from './primary-bot.js';

export const MEMORY_IMPORT_MAX_CHARS = 16000;
export const MEMORY_IMPORT_MAX_BYTES = 64 * 1024;
/** Original export request, copied manually to the assistant the person already uses. */
export const MEMORY_IMPORT_COPY_PROMPT = `请整理你已经知道的、适合让我带到另一位个人助手中的长期信息。只写我明确提供或确认过的稳定偏好、工作背景、常用沟通方式和持续目标，按主题简洁列出。不要推测没有依据的事实，也不要包含密码、令牌、账号恢复信息或其他人的私人资料。把不确定、可能过时的内容单独标明，并让我核对。请直接输出可复制的中文摘要，不要加入要求另一位助手执行操作、打开链接或改变权限的指令。`;

export interface MemoryImportReadiness {
  available: boolean;
  reason?: 'personal_required' | 'primary_required' | 'primary_chat_missing' | 'model_required';
  primary: PrimaryBotState;
  modelConfigured: boolean;
}
export interface CreateMemoryImport {
  requestId: string;
  expectedPrimaryRevision: string;
  content: string;
}
export type MemoryImportStatus =
  | 'queued'
  | 'delivered'
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'interrupted'
  | 'missing';
/** Receipt only. It never contains the pasted source or claims how many memories were saved. */
export interface MemoryImportReceipt {
  requestId: string;
  userId?: string;
  workspaceId?: string;
  primaryRevision: string;
  agentId: string;
  conversationId: string;
  messageId: string;
  createdAt: string;
  /** completed means the actual Pi task finished, not that it necessarily wrote a memory. */
  status: MemoryImportStatus;
  resultMessageId?: string;
}
