import { uiText } from './i18n';
import type { Message } from '../../shared/types';
import {
  matchesChatMentionReceipt,
  sameChatMentions,
  validChatMentions,
} from '../../shared/chat-mentions';
import { sameAppSelection, submissionKey, type SendAttempt } from './chatDrafts';

type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
type PendingRecord = {
  conversationId: string;
  clientId: string;
  threadRootId?: string;
  requestVoiceMemo?: true;
  fingerprint: string;
  createdAt: number;
};
const lifetime = 7 * 24 * 60 * 60 * 1000;
const capacity = 100;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\u0000-\u001f]/.test(value);
const recordKey = (conversationId: string, clientId: string) =>
  JSON.stringify([conversationId, clientId]);

/**
 * Receipt metadata for this tab, account and workspace. It does not cache chat
 * text or replay requests. Only an explicit send can reuse an unresolved ID.
 */
export function createPendingSubmissions(options: {
  userId: string | undefined;
  workspaceId: string;
  storage?: StorageAccess;
  now?: () => number;
}) {
  const now = options.now || Date.now;
  const key = `openbot-pending-v1:${JSON.stringify([options.userId ?? null, options.workspaceId])}`;
  let storage = options.storage;
  if (!storage) {
    try {
      if (typeof window !== 'undefined') storage = window.sessionStorage;
    } catch {
      // Privacy settings can deny storage access; the current tab still works.
    }
  }
  let persistent = !!storage;
  const records = new Map<string, PendingRecord>();
  const attempts = new Map<string, SendAttempt>();
  const fingerprints = new WeakMap<SendAttempt, { fingerprint: string; submission: string }>();
  const confirmed = new Map<string, number>();
  const save = () => {
    if (!persistent) return;
    try {
      storage!.setItem(key, JSON.stringify({ version: 1, records: [...records.values()] }));
    } catch {
      persistent = false;
    }
  };
  const prune = () => {
    const cutoff = now() - lifetime;
    let changed = false;
    for (const [id, record] of records) {
      if (record.createdAt <= cutoff) {
        records.delete(id);
        attempts.delete(id);
        changed = true;
      }
    }
    for (const [id, createdAt] of confirmed) {
      if (createdAt <= cutoff) confirmed.delete(id);
    }
    if (changed) save();
  };
  if (storage) {
    try {
      const raw = storage.getItem(key);
      if (raw !== null) {
        if (raw.length > 65536) throw new Error('Invalid receipt metadata');
        const saved: unknown = JSON.parse(raw);
        if (!saved || typeof saved !== 'object') throw new Error('Invalid receipt metadata');
        const data = saved as { version?: unknown; records?: unknown };
        if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > capacity)
          throw new Error('Invalid receipt metadata');
        for (const value of data.records) {
          if (!value || typeof value !== 'object') continue;
          const record = value as PendingRecord;
          if (
            !identifier(record.conversationId) ||
            !identifier(record.clientId) ||
            (record.threadRootId !== undefined && !identifier(record.threadRootId)) ||
            (record.requestVoiceMemo !== undefined && record.requestVoiceMemo !== true) ||
            typeof record.fingerprint !== 'string' ||
            !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
            !Number.isSafeInteger(record.createdAt) ||
            record.createdAt < 0 ||
            record.createdAt > now() + 5 * 60 * 1000 ||
            record.createdAt <= now() - lifetime
          )
            continue;
          const id = recordKey(record.conversationId, record.clientId);
          // Copy only receipt metadata and never arbitrary stored content.
          if (!records.has(id))
            records.set(id, {
              conversationId: record.conversationId,
              clientId: record.clientId,
              ...(record.threadRootId ? { threadRootId: record.threadRootId } : {}),
              ...(record.requestVoiceMemo ? { requestVoiceMemo: true } : {}),
              fingerprint: record.fingerprint,
              createdAt: record.createdAt,
            });
        }
        save();
      }
    } catch {
      // Unreadable metadata cannot establish receipt identity. Do not overwrite
      // it or claim durable recovery; retain new attempts in memory instead.
      persistent = false;
    }
  }
  return {
    get persistent() {
      return persistent;
    },
    async prepare(attempt: SendAttempt): Promise<SendAttempt> {
      if (!identifier(attempt.conversationId) || !identifier(attempt.clientId))
        throw new Error(uiText('common:text_0ca760a4d966'));
      if (
        attempt.agentId !== attempt.snapshot.agentId ||
        attempt.requestVoiceMemo !== attempt.snapshot.requestVoiceMemo ||
        (attempt.requestVoiceMemo &&
          (attempt.mode !== 'followUp' ||
            !!attempt.replyToMessageId ||
            !!attempt.threadRootId ||
            !!attempt.appContext ||
            !!attempt.mentions ||
            attempt.agentId !== undefined)) ||
        (attempt.threadRootId !== undefined && !identifier(attempt.threadRootId)) ||
        (attempt.agentId !== undefined && !identifier(attempt.agentId)) ||
        !sameAppSelection(attempt.appContext, attempt.snapshot.appContext) ||
        !sameChatMentions(attempt.mentions, attempt.snapshot.mentions) ||
        (attempt.mentions &&
          (!validChatMentions(attempt.mentions) ||
            attempt.agentId !== undefined ||
            !!attempt.appContext)) ||
        (attempt.appContext &&
          (!identifier(attempt.appContext.connectionId) ||
            !identifier(attempt.appContext.revision)))
      )
        throw new Error(uiText('common:text_a5609cf7faa8'));
      prune();
      // A bootstrap receipt may arrive while Web Crypto is hashing. Keep the
      // candidate IDs so that this explicit retry cannot become a fresh send.
      const beforeHash = [...records.values()];
      // The key includes an explicit recipient, while untargeted drafts retain
      // their existing key and can still recover old metadata-only receipts.
      const submission = submissionKey(attempt.snapshot, attempt.threadRootId);
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(submission));
      const fingerprint = Array.from(new Uint8Array(bytes), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('');
      prune();
      const ownId = recordKey(attempt.conversationId, attempt.clientId);
      if (confirmed.has(ownId)) return attempt;
      const previous = [...records.values()].find(
        (record) =>
          record.conversationId === attempt.conversationId && record.fingerprint === fingerprint,
      );
      const receivedDuringHash = beforeHash.find(
        (record) =>
          record.conversationId === attempt.conversationId &&
          record.fingerprint === fingerprint &&
          confirmed.has(recordKey(record.conversationId, record.clientId)),
      );
      if (!previous && receivedDuringHash)
        return { ...attempt, clientId: receivedDuringHash.clientId };
      if (!previous && records.size >= capacity)
        throw new Error(uiText('common:text_e6d09c3196c0'));
      if (!previous && records.has(ownId)) throw new Error(uiText('common:text_0f5e4aa33d88'));
      const prepared =
        previous && previous.clientId !== attempt.clientId
          ? { ...attempt, clientId: previous.clientId }
          : attempt;
      const id = recordKey(prepared.conversationId, prepared.clientId);
      records.set(
        id,
        previous || {
          conversationId: prepared.conversationId,
          clientId: prepared.clientId,
          ...(prepared.threadRootId ? { threadRootId: prepared.threadRootId } : {}),
          ...(prepared.requestVoiceMemo ? { requestVoiceMemo: true } : {}),
          fingerprint,
          createdAt: now(),
        },
      );
      attempts.set(id, prepared);
      fingerprints.set(prepared, { fingerprint, submission });
      save();
      return prepared;
    },
    /** Only call after a definite server refusal, never for an unknown outcome. */
    reject(attempt: SendAttempt): void {
      prune();
      const id = recordKey(attempt.conversationId, attempt.clientId);
      const record = records.get(id);
      const prepared = fingerprints.get(attempt);
      if (
        !record ||
        !prepared ||
        record.fingerprint !== prepared.fingerprint ||
        prepared.submission !== submissionKey(attempt.snapshot, attempt.threadRootId)
      )
        return;
      records.delete(id);
      attempts.delete(id);
      save();
    },
    confirm(message: Message): SendAttempt | undefined {
      prune();
      if (
        message.role !== 'user' ||
        message.userId !== options.userId ||
        !message.delivery?.clientId
      )
        return undefined;
      const id = recordKey(message.conversationId, message.delivery.clientId);
      const record = records.get(id);
      if (!record || record.threadRootId !== message.threadRootId) return undefined;
      if (Boolean(record.requestVoiceMemo) !== (message.metadata?.requestVoiceMemo === true))
        return undefined;
      const attempt = attempts.get(id);
      if (attempt?.agentId !== undefined && message.delivery.agentId !== attempt.agentId)
        return undefined;
      if (attempt && !sameAppSelection(attempt.appContext, message.appContext)) return undefined;
      if (attempt && !matchesChatMentionReceipt(attempt.mentions, message.mentions))
        return undefined;
      records.delete(id);
      attempts.delete(id);
      confirmed.set(id, now());
      // Only currently in-flight fetches need this memory after the receipt is
      // retired; retain a bounded recent set for late rejection handling.
      while (confirmed.size > 400) confirmed.delete(confirmed.keys().next().value!);
      save();
      return attempt;
    },
    wasConfirmed(attempt: SendAttempt): boolean {
      prune();
      return confirmed.has(recordKey(attempt.conversationId, attempt.clientId));
    },
    pending(conversationId?: string, threadRootId?: string): number {
      prune();
      return [...records.values()].filter(
        (record) =>
          !conversationId ||
          (record.conversationId === conversationId && record.threadRootId === threadRootId),
      ).length;
    },
  };
}
