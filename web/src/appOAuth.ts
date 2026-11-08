import { uiText } from './i18n';
import type { AppOAuthPhase } from '../../shared/app-oauth';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const pathPattern = new RegExp(`^/app-authorize/(${uuid})/(${uuid})/(${uuid})$`);
export function parseAppAuthorizationPath(path: string) {
  const match = pathPattern.exec(path);
  return match ? { workspaceId: match[1], connectionId: match[2], flowId: match[3] } : undefined;
}
export function appAuthorizationPath(workspaceId: string, connectionId: string, flowId: string) {
  const path = `/app-authorize/${workspaceId}/${connectionId}/${flowId}`;
  if (!parseAppAuthorizationPath(path)) throw new Error(uiText('apps:text_f4d956dc429e'));
  return path;
}
export const oauthPhaseLabel = (status: AppOAuthPhase) =>
  ({
    preparing: uiText('apps:text_c45e35e707c2'),
    pending: uiText('apps:text_e67a4e34621c'),
    callback_received: uiText('apps:text_fc0991ee49ee'),
    exchanging: uiText('apps:text_63cdea6bd39e'),
    complete: uiText('apps:text_a883b324843d'),
    cancelled: uiText('apps:text_09be93703b2d'),
    expired: uiText('apps:text_956ef6fafa63'),
    error: uiText('apps:text_ae88c27aae02'),
  })[status];
export const oauthPending = (status: AppOAuthPhase) =>
  ['preparing', 'pending', 'callback_received', 'exchanging'].includes(status);
export function validAuthorizationUrl(value: string, origin?: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!url.port || url.port === '443') &&
      !!origin &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}
declare global {
  interface Window {
    openbotAuthorization?: {
      open: (request: {
        workspaceId: string;
        connectionId: string;
        flowId: string;
        expectedUserId: string;
      }) => Promise<{ opened: boolean }>;
    };
  }
}
