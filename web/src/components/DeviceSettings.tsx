import { useAccount } from '../AccountContext';
import { AccountDevices } from '../platform/AccountDevices';

/** Device sessions belong to the authenticated account, independently of workspace roles. */
export function DeviceSettings() {
  const account = useAccount();
  if (!account?.session.user) return null;
  return (
    <AccountDevices
      key={account.session.user.id}
      userId={account.session.user.id}
      onExpired={() => window.dispatchEvent(new Event('openbot:account-expired'))}
      onIdentityChanged={() => window.dispatchEvent(new Event('openbot:revalidate'))}
    />
  );
}
