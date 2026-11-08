import { uiText } from './i18n';
import type { PrimaryBotIdentity } from './primaryBot';

export const teachingUuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
export type TeachingOperation =
  'idle' | 'start' | 'stop' | 'review' | 'generate' | 'cancel' | 'legacy';
export type TeachingPending = {
  version: 2;
  id: string;
  operationId: string;
  kind: TeachingOperation;
  expectedRevision?: string;
  requestId?: string;
};

// Persist identifiers and receipts only; request bodies stay in the current view.
export function teachingPendingStore(
  identity: PrimaryBotIdentity & { agentId: string; conversationId: string },
  supplied?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
) {
  const key = `openbot-teaching:${JSON.stringify([identity.workspaceId, identity.userId, identity.agentId, identity.conversationId])}`;
  let storage = supplied;
  let raw: string | null = null;
  let value: TeachingPending | undefined;
  const invalid = () => Error(uiText('workspace:teachingInvalid'));
  function available() {
    storage ||= typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
    if (!storage) throw Error(uiText('workspace:teachingStorage'));
    return storage;
  }
  function replace(next?: TeachingPending) {
    const target = available();
    if (target.getItem(key) !== raw) throw invalid();
    const encoded = next ? JSON.stringify(next) : null;
    if (encoded) target.setItem(key, encoded);
    else target.removeItem(key);
    raw = encoded;
    value = next;
  }
  return {
    get value() {
      return value;
    },
    current() {
      try {
        return available().getItem(key) === raw;
      } catch {
        return false;
      }
    },
    replace,
    load() {
      raw = available().getItem(key);
      if (!raw) {
        value = undefined;
        return;
      }
      if (raw.length > 2048) throw invalid();
      const parsed = teachingUuid.test(raw) ? { id: raw } : JSON.parse(raw);
      if (!parsed || !teachingUuid.test(parsed.id)) throw invalid();
      if (parsed.version === 2) {
        if (
          !teachingUuid.test(parsed.operationId) ||
          !['idle', 'start', 'stop', 'review', 'generate', 'cancel', 'legacy'].includes(
            parsed.kind,
          ) ||
          (parsed.expectedRevision !== undefined && !teachingUuid.test(parsed.expectedRevision)) ||
          (parsed.requestId !== undefined && !teachingUuid.test(parsed.requestId)) ||
          (parsed.kind === 'generate' && (!parsed.requestId || !parsed.expectedRevision)) ||
          (parsed.kind === 'review' && !parsed.expectedRevision) ||
          Object.keys(parsed).some(
            (field) =>
              !['version', 'id', 'operationId', 'kind', 'expectedRevision', 'requestId'].includes(
                field,
              ),
          )
        )
          throw invalid();
        value = parsed;
        return;
      }
      const generation = parsed.generation;
      if (
        Object.keys(parsed).some((field) => !['id', 'generation'].includes(field)) ||
        (generation &&
          (!teachingUuid.test(generation.requestId) ||
            !teachingUuid.test(generation.expectedRevision)))
      )
        throw invalid();
      replace({
        version: 2,
        id: parsed.id,
        operationId: crypto.randomUUID(),
        kind: generation ? 'generate' : 'legacy',
        ...(generation
          ? { requestId: generation.requestId, expectedRevision: generation.expectedRevision }
          : {}),
      });
    },
  };
}
