import { uiText } from '../../../web/src/i18n';
import type { AccountStatus } from '../../../shared/platform';
import '../../../web/src/admin/Admin.css';
import '../../../web/src/platform/Platform.css';
import { View, views } from './types';
export function Status({ value }: { value: AccountStatus }) {
  return (
    <span className={`admin-status ${value === 'suspended' ? 'is-muted' : ''}`}>
      {value === 'active'
        ? uiText('platform:text_296de0e31f8c')
        : uiText('platform:text_a8c3698b5b8c')}
    </span>
  );
}
export function initialView(): View {
  return views.find((item) => item.id === window.location.hash.slice(1))?.id || 'overview';
}
