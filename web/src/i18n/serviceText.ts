import { currentLanguage, resources } from './index';
import { serviceMessages } from './serviceMessages';
import type { Message } from '../../../shared/types';

// The service stores these fallback bodies alongside the typed computer action state.
const computerReceiptStatusMessages = new Set([
  '电脑操作等待发起人批准。',
  '正在执行电脑操作。',
  '电脑操作已完成。',
  '电脑操作已取消。',
  '电脑操作未能确认完成，请核对结果。',
]);

export function isComputerReceiptStatusMessage(value: string): boolean {
  return computerReceiptStatusMessages.has(value);
}

const translations = new Map<string, string>(Object.entries(serviceMessages));
for (const namespace of Object.keys(resources['zh-CN'])) {
  const chinese = resources['zh-CN'][namespace as keyof (typeof resources)['zh-CN']];
  const english = resources.en[namespace as keyof typeof resources.en];
  for (const [key, source] of Object.entries(chinese)) {
    const target = (english as Record<string, string>)[key];
    if (typeof source === 'string' && target && !source.includes('{{') && !translations.has(source))
      translations.set(source, target);
  }
}

/** Apply only at an explicitly service-owned status/error field, never a whole DTO or chat body. */
export function serviceText(value: string | undefined): string {
  if (!value) return '';
  return currentLanguage() === 'en' ? (translations.get(value) ?? value) : value;
}

const stoppedTaskNotice = '任务已停止，已完成的工作保留。';

/** Translate the service notice appended to a terminal agent run. */
export function chatMessageText(
  message: Pick<Message, 'role' | 'kind' | 'status' | 'content' | 'metadata'>,
): string {
  const { role, kind, status, content, metadata } = message;
  if (
    role !== 'assistant' ||
    kind !== 'text' ||
    status !== 'error' ||
    typeof metadata?.runId !== 'string' ||
    (metadata.executionStatus !== 'cancelled' && metadata.executionStatus !== 'error')
  )
    return content;
  if (content === stoppedTaskNotice) return serviceText(stoppedTaskNotice);
  if (content.endsWith(`\n\n${stoppedTaskNotice}`))
    return content.slice(0, -stoppedTaskNotice.length) + serviceText(stoppedTaskNotice);
  return content;
}
