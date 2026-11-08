import type { Bootstrap, Message } from '../../shared/types';
import { canDecideAction } from '../../shared/approvals';
import { uiText } from './i18n';
import type { createNotificationPreferences } from './notificationPreferences';
import type { NotificationIdentity } from './notificationTransport';

const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export function notificationEvent(message: Message) {
  if (message.role !== 'assistant' || !id(message.agentId)) return;
  const metadata = message.metadata || {};
  for (const [type, value] of [
    ['app', metadata.appAction],
    ['computer', metadata.action],
  ] as const) {
    const action = object(value);
    if (
      action?.status !== 'pending' ||
      !id(action.id) ||
      (action.agentId !== undefined && action.agentId !== message.agentId) ||
      (action.conversationId !== undefined && action.conversationId !== message.conversationId)
    )
      continue;
    if (
      type === 'app' &&
      (action.agentId !== message.agentId || action.conversationId !== message.conversationId)
    )
      continue;
    if (
      action.expiresAt !== undefined &&
      (typeof action.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(action.expiresAt)) ||
        Date.parse(action.expiresAt) <= Date.now())
    )
      continue;
    return {
      kind: 'approvals' as const,
      agentId: message.agentId,
      key: `${message.agentId}:approval:${type}:${action.id}`,
      requester: action.requester,
    };
  }
  if (
    message.status === 'done' &&
    (message.kind === 'text' || message.kind === undefined) &&
    id(metadata.runId) &&
    !metadata.delegation &&
    !metadata.executionStatus
  ) {
    return {
      kind: 'completed' as const,
      agentId: message.agentId,
      key: `${message.agentId}:completed:${metadata.runId}`,
      inputId: metadata.inputMessageId,
    };
  }
}

export function createNotificationEvents(options: {
  identity: NotificationIdentity;
  current: () => boolean;
  isOwner: () => boolean;
  background: () => boolean;
  preferences: ReturnType<typeof createNotificationPreferences>;
  exclusive?: (work: () => void) => Promise<unknown>;
}) {
  const messages = new Map<string, Message>();
  const names = new Map<string, string>();
  const observed = new Set<string>();
  let ready = false,
    active = true;
  const current = () =>
    active && options.current() && !!options.identity.userId && !!options.identity.workspaceId;
  function baseline(data: Bootstrap) {
    if (!current()) return;
    names.clear();
    data.agents.forEach((agent) => names.set(agent.id, agent.name));
    messages.clear();
    data.messages.forEach((message) => {
      messages.set(message.id, message);
      const event = notificationEvent(message);
      if (event) observed.add(event.key);
    });
    ready = true;
  }
  function receive(message: Message) {
    if (!current()) return;
    messages.set(message.id, message);
    const event = notificationEvent(message);
    if (!event || observed.has(event.key)) return;
    observed.add(event.key);
    if (options.exclusive) {
      void options
        .exclusive(() => deliver(event))
        .catch(() => {
          if (current()) options.preferences.failure();
        });
    } else deliver(event);
  }
  function deliver(event: NonNullable<ReturnType<typeof notificationEvent>>) {
    if (!current()) return;
    if (!options.preferences.claim(event.key) || !ready) return;
    const preferences = options.preferences.getSnapshot();
    if (
      !preferences.enabled ||
      !preferences.storageAvailable ||
      preferences.permission !== 'granted' ||
      !preferences[event.kind] ||
      preferences.mutedBots.includes(event.agentId) ||
      !options.background()
    )
      return;
    if (event.kind === 'approvals') {
      if (
        !canDecideAction(event.requester, {
          userId: options.identity.userId,
          isOwner: options.isOwner(),
        })
      )
        return;
    } else {
      const input = typeof event.inputId === 'string' ? messages.get(event.inputId) : undefined;
      const ownInput = input?.role === 'user' && input.userId === options.identity.userId;
      const scheduled =
        input?.role === 'system' &&
        !input.metadata?.delegation &&
        !!(input.metadata?.routineRun || input.metadata?.primaryCheckIn) &&
        options.isOwner();
      if (!ownInput && !scheduled) return;
    }
    const bot =
      names
        .get(event.agentId)
        ?.replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, 80) || uiText('workspace:notificationsBot');
    const title = uiText(
      event.kind === 'completed'
        ? 'workspace:notificationsCompletedTitle'
        : 'workspace:notificationsApprovalTitle',
      { bot },
    );
    void options.preferences.transport
      .show({ eventId: event.key, title, body: '' }, current)
      .catch(() => {
        if (current()) options.preferences.failure();
      });
  }
  return {
    baseline,
    receive,
    invalidate() {
      ready = false;
      void options.preferences.transport.clear();
    },
    suspend() {
      active = false;
      ready = false;
      options.preferences.transport.clear();
    },
    resume() {
      active = true;
    },
  };
}
