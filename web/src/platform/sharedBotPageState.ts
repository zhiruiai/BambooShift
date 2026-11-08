import { uiText } from '../i18n';
import type { AccountSession } from '../../../shared/platform';
import type { ConfirmedSharedBot } from '../sharedBots';

export const sharedBotPersonalTargets = (session?: AccountSession) =>
  session?.authenticated && session.user?.status === 'active'
    ? session.workspaces.filter(
        (workspace) =>
          workspace.kind === 'personal' &&
          workspace.role === 'owner' &&
          workspace.status === 'active',
      )
    : [];

export interface SharedBotPageState {
  session?: AccountSession;
  loading: boolean;
  error: string;
}

/** The link itself never grants access. Read the current account before opening its scoped preview. */
export function createSharedBotPageReader(options: {
  fetch?: typeof fetch;
  current: () => boolean;
  onChange: (state: SharedBotPageState) => void;
}) {
  let active = true,
    sequence = 0,
    controller: AbortController | undefined;
  let state: SharedBotPageState = { loading: true, error: '' };
  const current = (ticket: number) => active && options.current() && sequence === ticket;
  const publish = (patch: Partial<SharedBotPageState>) => {
    state = { ...state, ...patch };
    options.onChange(state);
  };
  return {
    resume() {
      active = true;
    },
    suspend() {
      active = false;
      sequence++;
      controller?.abort();
    },
    async read() {
      if (!active || !options.current()) return;
      const ticket = ++sequence;
      controller?.abort();
      controller = new AbortController();
      publish({ loading: true, error: '' });
      try {
        const response = await (options.fetch || fetch)('/api/account/session', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        });
        if (!response.ok) throw new Error(uiText('account:text_694fd48afce8'));
        const session = (await response.json()) as AccountSession;
        if (session.authenticated && (!session.user || session.user.status !== 'active'))
          throw new Error(uiText('account:text_8bcf7af567bb'));
        if (current(ticket)) publish({ session, loading: false, error: '' });
      } catch (cause) {
        if (current(ticket))
          publish({ session: undefined, loading: false, error: (cause as Error).message });
      }
    },
  };
}

export function sharedBotConversationPath(
  confirmed: ConfirmedSharedBot,
  expected: { userId?: string; workspaceId?: string; shareId: string },
) {
  const { receipt, agent, conversation } = confirmed;
  if (
    !expected.userId ||
    !expected.workspaceId ||
    receipt.actorId !== expected.userId ||
    receipt.workspaceId !== expected.workspaceId ||
    receipt.shareId !== expected.shareId ||
    agent.id !== receipt.agentId ||
    agent.sharedBot?.shareId !== expected.shareId ||
    conversation.id !== receipt.conversationId ||
    conversation.isGroup ||
    conversation.agentIds.length !== 1 ||
    conversation.agentIds[0] !== agent.id
  )
    return;
  return `/w/${encodeURIComponent(expected.workspaceId)}?conversation=${encodeURIComponent(conversation.id)}`;
}
