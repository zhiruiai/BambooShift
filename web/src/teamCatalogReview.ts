import type { BotAgent } from '../../shared/types';
import type {
  BotTeamDraft,
  BotTeamCatalogReview,
  RefreshBotTeamCatalog,
} from '../../shared/bot-team-plans';
import { botProfileDraft } from './botProfiles';

export type CatalogRequest = {
  version: 1;
  planId: string;
  requestId: string;
  expectedRevision: string;
  body?: RefreshBotTeamCatalog;
};
export type CatalogPreview = {
  value: BotTeamCatalogReview;
  draft: BotTeamDraft;
  profiles: string;
};
export const catalogStorageKey = (props: { userId?: string; workspaceId?: string }) =>
  `openbot-team-catalog:${JSON.stringify([props.userId || null, props.workspaceId || null])}`;
export function restoredCatalogRequest(key: string): CatalogRequest | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 1024) return;
    const value = JSON.parse(raw);
    if (
      value?.version === 1 &&
      ['planId', 'requestId', 'expectedRevision'].every(
        (field) => typeof value[field] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value[field]),
      )
    )
      return {
        version: 1,
        planId: value.planId,
        requestId: value.requestId,
        expectedRevision: value.expectedRevision,
      };
  } catch {
    /* A new write must still prove that recovery metadata can be saved. */
  }
}
export function catalogProfiles(draft: BotTeamDraft | undefined, agents: BotAgent[]) {
  return JSON.stringify(
    draft?.members
      .filter((member) => member.kind === 'reuse')
      .map((member) => {
        const agent = agents.find((item) => item.id === member.agentId);
        return [
          member.key,
          member.agentId,
          agent
            ? {
                ...botProfileDraft(agent),
                configRevision: agent.configRevision,
                sharedBot: agent.sharedBot,
              }
            : null,
        ];
      }),
  );
}
