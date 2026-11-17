import { uiText } from './i18n';

export function searchShortcutLabel(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
) {
  return uiText(
    /\bMacintosh\b/.test(userAgent)
      ? 'workspace:searchShortcutMac'
      : 'workspace:searchShortcutControl',
  );
}
