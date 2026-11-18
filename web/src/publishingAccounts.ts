import defaults from '../../shared/publishing-sites.json';
import { validAppAddress } from './appConnections';

export type PublishingSite = { name: string; url: string };
export const publishingSites: readonly PublishingSite[] = defaults;

export function validPublishingAddress(raw: string) {
  if (!validAppAddress(raw) || /[?#\\\p{Cc}]/u.test(raw)) return false;
  const host = new URL(raw).hostname.replace(/\.$/, '');
  return (
    host.includes('.') &&
    !/^[\d.]+$/.test(host) &&
    !host.includes(':') &&
    !/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host)
  );
}

export type PublishingLogin = { site: PublishingSite; agentId: string };
export type ComputerConversation = {
  id: string;
  title: string;
  scope: string;
  publishingLogin?: PublishingLogin;
};
