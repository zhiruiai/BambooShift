import type { ConnectedApp } from '../../shared/app-connections';
import type { Conversation } from '../../shared/types';
import { providerConnection, providerDraft, type AppProvider } from './appProviders';

export type CustomAppProposalEntry = {
  kind: 'custom_mcp';
  messageId: string;
  name: string;
  url: string;
};
export type AppProposalEntry = string | CustomAppProposalEntry;
export type AppReviewTarget = AppProvider | CustomAppProposalEntry;

export function canReviewCustomApp(chat: Conversation | undefined, agentId: string) {
  return (
    !!chat &&
    !chat.demo &&
    !chat.isGroup &&
    chat.agentIds.length === 1 &&
    chat.agentIds[0] === agentId
  );
}

export function reviewConnection(target: AppReviewTarget, apps: ConnectedApp[]) {
  if ('kind' in target) return apps.find((app) => app.url === target.url);
  return providerConnection(target, apps);
}

export function reviewDraft(target: AppReviewTarget) {
  if ('kind' in target)
    return {
      name: target.name.slice(0, 80),
      url: target.url,
      authType: 'none' as const,
      token: '',
      shared: false,
    };
  return providerDraft(target.id);
}

export function matchesReviewedAddress(target: AppReviewTarget, url: string) {
  if ('kind' in target) return url === target.url;
  return url.trim().replace(/\/$/, '') === target.url.replace(/\/$/, '');
}
