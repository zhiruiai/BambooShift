import { uiText } from '../../i18n';

export function AccountInitial({ name }: { name?: string }) {
  return (
    <span className="account-initial" aria-hidden="true">
      {Array.from(name?.trim() || uiText('account:text_b70bb4acc048'))[0]}
    </span>
  );
}
