import { useEffect, useRef, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import {
  isCustomAppConnectionProposal,
  parseAppConnectionProposal,
  sameAppConnectionProposal,
} from '../../../shared/app-proposals';
import type { Bootstrap, Message } from '../../../shared/types';
import type { ConnectedApp } from '../../../shared/app-connections';
import type { AccountSession } from '../../../shared/platform';
import { appProviders } from '../appProviders';
import {
  canReviewCustomApp,
  reviewConnection,
  type AppProposalEntry,
  type CustomAppProposalEntry,
} from '../appProposalEntry';
import { appConnectionStatus, createAppConnectionScope } from '../appConnections';
import { platformApi } from '../platform/platformApi';
import { uiText } from '../i18n';
import './AppsDialog.css';
type Props = {
  message: Message;
  workspaceId?: string;
  userId?: string;
  owner: boolean;
  localBotAvailable: boolean;
  customScope?: boolean;
  apps?: ConnectedApp[];
  current?: () => boolean;
  onOpen: (entry: AppProposalEntry, agentId: string) => boolean | void;
};
export function AppConnectionProposalCard(props: Props) {
  return (
    <AppConnectionProposalContent
      key={`${props.workspaceId}:${props.userId}:${props.message.id}`}
      {...props}
    />
  );
}
function AppConnectionProposalContent(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createAppConnectionScope({ ...props, identity: () => latest.current }),
  );
  const busyRef = useRef(false),
    pending = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    scope.resume();
    return () => {
      scope.suspend();
      pending.current?.abort();
    };
  }, [scope]);
  const proposal = parseAppConnectionProposal(props.message);
  if (!proposal) return null;
  const custom = isCustomAppConnectionProposal(proposal);
  const customEntry: CustomAppProposalEntry | undefined = custom
    ? { kind: 'custom_mcp', messageId: props.message.id, name: proposal.name, url: proposal.url }
    : undefined;
  const provider = !custom
    ? appProviders.find((item) => item.id === proposal.providerId)
    : undefined;
  const target = customEntry ?? provider;
  if (!target) return null;
  const app = props.apps && reviewConnection(target, props.apps);
  const action = error
    ? 'workspace:appProposalRetry'
    : app?.status === 'connected'
      ? 'workspace:appProposalManage'
      : app?.authType === 'oauth'
        ? 'workspace:appProposalAuthorize'
        : app
          ? 'workspace:appProposalReviewConnection'
          : 'workspace:appProposalOpen';
  const eligible = () => {
    const p = latest.current,
      value = parseAppConnectionProposal(p.message);
    return (
      !!p.userId &&
      !!p.workspaceId &&
      p.owner &&
      p.localBotAvailable &&
      value?.requester.userId === p.userId &&
      (!value || !isCustomAppConnectionProposal(value) || p.customScope)
    );
  };
  const allowed = () => eligible() && (latest.current.current?.() ?? true);
  async function open() {
    const ticket = scope.ticket(),
      original = latest.current.message;
    if (!scope.current(ticket) || !allowed() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    pending.current = controller;
    try {
      const session = await platformApi<AccountSession>('/account/session', 'GET', undefined, {
        expectedUser: props.userId,
        signal: controller.signal,
      });
      if (!scope.current(ticket) || !allowed() || controller.signal.aborted) return;
      if (
        !session.authenticated ||
        session.user?.id !== props.userId ||
        session.user?.status !== 'active' ||
        !session.workspaces.some(
          (w) =>
            w.id === props.workspaceId &&
            w.role === 'owner' &&
            w.status === 'active' &&
            (!custom || w.kind === 'personal'),
        )
      )
        throw Error(uiText('workspace:appProposalUnavailable'));
      const data = await scope.request<Bootstrap>('/bootstrap');
      if (
        !scope.current(ticket) ||
        !allowed() ||
        !sameAppConnectionProposal(original, latest.current.message)
      )
        return;
      const message = data.messages.find((item) => item.id === original.id);
      const bot = data.agents.find((item) => item.id === original.agentId && !item.sharedBot);
      const chat = data.conversations.find(
        (item) => item.id === original.conversationId && item.agentIds.includes(original.agentId!),
      );
      if (!message || !sameAppConnectionProposal(original, message) || !bot || !chat || chat.demo)
        throw Error(uiText('workspace:appProposalUnavailable'));
      if (custom) {
        const input = data.messages.find((item) => item.id === proposal.requester.messageId);
        if (
          !canReviewCustomApp(chat, bot.id) ||
          input?.role !== 'user' ||
          input.userId !== props.userId ||
          input.conversationId !== chat.id ||
          input.threadRootId !== message.threadRootId
        )
          throw Error(uiText('workspace:appProposalUnavailable'));
      }
      const entry = customEntry ?? provider?.id;
      if (!entry || latest.current.onOpen(entry, bot.id) === false)
        throw Error(uiText('workspace:appProposalUnavailable'));
    } catch {
      if (scope.current(ticket) && !controller.signal.aborted)
        setError(uiText('workspace:appProposalUnavailable'));
    } finally {
      busyRef.current = false;
      if (pending.current === controller) pending.current = undefined;
      if (scope.current(ticket)) setBusy(false);
    }
  }
  return (
    <section
      className="app-action-card"
      aria-label={uiText('workspace:appProposalTitle', { provider: target.name })}
    >
      <header>
        <Link2 size={16} />
        <strong>{uiText('workspace:appProposalTitle', { provider: target.name })}</strong>
        {props.apps && (
          <span className="app-action-state" role="status">
            {app ? appConnectionStatus(app.status) : uiText('workspace:appProposalNotConnected')}
          </span>
        )}
      </header>
      {customEntry && (
        <p
          className="app-proposal-endpoint"
          aria-label={uiText('workspace:appProposalCustomEndpoint')}
        >
          {customEntry.url}
        </p>
      )}
      <p>{proposal.reason}</p>
      <p className="field-help">
        {uiText(
          app?.status === 'connected'
            ? 'workspace:appProposalConnectedHelp'
            : app
              ? 'workspace:appProposalExistingHelp'
              : custom
                ? 'workspace:appProposalCustomReview'
                : 'workspace:appProposalReview',
        )}
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={!allowed() || busy}
        onClick={() => void open()}
      >
        {busy && <Loader2 size={14} className="spin" />}
        {uiText(action)}
      </button>
      {!eligible() && (
        <p className="field-help">
          {uiText(custom ? 'workspace:appProposalCustomOwner' : 'workspace:appProposalOwner')}
        </p>
      )}
    </section>
  );
}
