import { ArrowUpRight, UserRound } from 'lucide-react';
import { useAccount } from '../../AccountContext';
import { uiText } from '../../i18n';
import { AccountInitial } from '../../platform/account/AccountInitial';

export function SettingsAccountCard({
  userId,
  onAccount,
}: {
  userId?: string;
  onAccount: () => void;
}) {
  const account = useAccount();
  const user =
    account?.session.authenticated && account.session.user?.id === userId
      ? account.session.user
      : undefined;
  return (
    <section
      className="workspace-settings-section"
      aria-label={uiText('workspace:settingsAccount')}
    >
      <h3>{uiText('workspace:settingsAccount')}</h3>
      <div className="settings-account-card workspace-settings-card">
        {user ? <AccountInitial name={user.name} /> : <UserRound size={28} aria-hidden="true" />}
        <div className="settings-account-copy">
          <strong>{user?.name || uiText('workspace:settingsLocalAccount')}</strong>
          <span>{user?.email || uiText('workspace:settingsLocalAccountHint')}</span>
        </div>
        {userId && (
          <a
            className="secondary-button"
            href="/account"
            onClick={(event) => {
              event.preventDefault();
              onAccount();
            }}
          >
            {uiText('workspace:settingsManageAccount')}
            <ArrowUpRight size={15} />
          </a>
        )}
      </div>
    </section>
  );
}
