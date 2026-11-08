import type { Bootstrap, Message } from '../../../shared/types';
import { createNotificationPreferences } from '../notificationPreferences';
import { createNotificationEvents } from '../notificationEvents';
import type { NotificationNotice, NotificationPermissionState } from '../notificationTransport';
export const identity = { userId: 'user-a', workspaceId: '00000000-0000-4000-8000-000000000001' };
export function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
export const input = (userId = identity.userId): Message => ({
  id: 'input-a',
  conversationId: 'chat-a',
  agentId: 'bot-a',
  role: 'user',
  userId,
  content: 'SYNTHETIC_PRIVATE_PROMPT',
  createdAt: '2026-11-01T00:00:00Z',
  delivery: { state: 'delivered', mode: 'followUp', runId: 'run-a' },
});
export const completed = (runId = 'run-a'): Message => ({
  id: `result-${runId}`,
  conversationId: 'chat-a',
  agentId: 'bot-a',
  role: 'assistant',
  kind: 'text',
  status: 'done',
  content: 'SYNTHETIC_PRIVATE_RESULT',
  createdAt: '2026-11-01T00:01:00Z',
  metadata: { runId, inputMessageId: 'input-a' },
});
export const approval = (userId: unknown = identity.userId, computer = false): Message => ({
  id: 'approval-a',
  conversationId: 'chat-a',
  agentId: 'bot-a',
  role: 'assistant',
  kind: computer ? 'computer' : 'approval',
  content: 'SYNTHETIC_PRIVATE_ARGUMENT',
  createdAt: '2026-11-01T00:00:00Z',
  metadata: {
    [computer ? 'action' : 'appAction']: {
      id: computer ? 'computer-action' : 'app-action',
      agentId: 'bot-a',
      ...(computer ? {} : { conversationId: 'chat-a' }),
      status: 'pending',
      ...(userId === undefined ? {} : { requester: { userId } }),
      arguments: { secret: 'SYNTHETIC_SECRET' },
    },
  },
});
export function snapshot(messages: Message[] = [input()]) {
  return { agents: [{ id: 'bot-a', name: 'Synthetic Bot' }], messages } as Bootstrap;
}
export async function fixture(
  options: {
    storage?: ReturnType<typeof storage>;
    userId?: string;
    owner?: boolean;
    permission?: NotificationPermissionState;
  } = {},
) {
  const saved = options.storage || storage(),
    notices: NotificationNotice[] = [];
  let active = true,
    background = true,
    permission = options.permission || 'granted',
    requested = 0,
    cleared = 0;
  const prefs = createNotificationPreferences({
    identity: { ...identity, userId: options.userId || identity.userId },
    storage: saved,
    transport: {
      permission: async () => permission,
      requestPermission: async () => {
        requested++;
        return permission;
      },
      show: async (notice, current) => {
        if (current()) notices.push(notice);
      },
      clear: async () => {
        cleared++;
      },
    },
  });
  const unsubscribe = prefs.subscribe(() => {});
  await Promise.resolve();
  const events = createNotificationEvents({
    identity: { ...identity, userId: options.userId || identity.userId },
    current: () => active,
    isOwner: () => options.owner === true,
    background: () => background,
    preferences: prefs,
  });
  return {
    saved,
    prefs,
    events,
    notices,
    get requested() {
      return requested;
    },
    get cleared() {
      return cleared;
    },
    setActive(value: boolean) {
      active = value;
    },
    setBackground(value: boolean) {
      background = value;
    },
    setPermission(value: NotificationPermissionState) {
      permission = value;
    },
    dispose() {
      events.suspend();
      unsubscribe();
      prefs.dispose();
    },
  };
}
