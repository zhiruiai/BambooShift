import { currentLanguage, resources } from './index';
import { serviceMessages } from './serviceMessages';

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
