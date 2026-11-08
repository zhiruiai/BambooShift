import type {
  GenerateTeaching,
  ReviewTeaching,
  StartTeaching,
  TeachingSession,
} from '../../shared/teaching';
import { ApiError } from './api';
import { createPrimaryBotScope, type PrimaryBotIdentity } from './primaryBot';
import { uiText } from './i18n';
import {
  teachingPendingStore,
  teachingUuid as uuid,
  type TeachingOperation,
} from './teachingPending';
export type TeachingModel = { id: string; name: string; configured: boolean; fingerprint?: string };
export type TeachingState = {
  busy: boolean;
  error: string;
  ready?: boolean;
  inputBlocked?: boolean;
  session?: TeachingSession;
  sessions: TeachingSession[];
  pendingId?: string;
  uncertain?: boolean;
  models: TeachingModel[];
};
export function createTeachingClient(
  options: PrimaryBotIdentity & {
    agentId: string;
    conversationId: string;
    identity: () => PrimaryBotIdentity;
    locationWorkspace?: () => string | undefined;
    binding?: () => string | undefined;
    fetch?: typeof fetch;
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    onState?: (state: TeachingState) => void;
  },
) {
  const scope = createPrimaryBotScope(options);
  const recovery = teachingPendingStore(options, options.storage);
  let state: TeachingState = {
    busy: false,
    error: '',
    ready: false,
    inputBlocked: true,
    sessions: [],
    models: [],
  };
  let loaded = false,
    sequence = 0;
  let recordingBinding: string | undefined;
  const current = () => !!options.userId && !!options.workspaceId && scope.current(scope.ticket());
  const binding = () => (options.binding ? options.binding() : 'test-binding');
  const snapshot = () => ({
    ...state,
    pendingId: recovery.value?.id,
    uncertain: !recovery.current() || (!!recovery.value && recovery.value.kind !== 'idle'),
    inputBlocked:
      !state.ready ||
      state.busy ||
      !recovery.current() ||
      (!!recovery.value && recovery.value.kind !== 'idle') ||
      (state.session?.status === 'recording' &&
        (!recordingBinding || binding() !== recordingBinding)),
  });
  const publish = (patch: Partial<TeachingState> = {}) => {
    state = { ...state, ...patch };
    if (current()) options.onState?.(snapshot());
  };
  const invalid = () => Error(uiText('workspace:teachingInvalid'));
  const safeText = (value: unknown, limit: number) =>
    typeof value === 'string' && value.length <= limit && !value.includes('\0');
  const valid = (value: TeachingSession, id?: string) => {
    if (
      !value ||
      !uuid.test(value.id) ||
      (id && value.id !== id) ||
      !uuid.test(value.revision) ||
      value.agentId !== options.agentId ||
      value.conversationId !== options.conversationId ||
      !safeText(value.goal, 2000) ||
      typeof value.interrupted !== 'boolean' ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !value.screen ||
      !uuid.test(value.screen.instanceId) ||
      !['browser', 'desktop'].includes(value.screen.surface) ||
      (value.screen.screenId !== undefined &&
        (!safeText(value.screen.screenId, 128) || !value.screen.screenId)) ||
      (value.generationRequestId !== undefined && !uuid.test(value.generationRequestId)) ||
      !Array.isArray(value.steps) ||
      value.steps.length > 60 ||
      !['recording', 'review', 'interrupted', 'generating', 'proposed', 'error'].includes(
        value.status,
      )
    )
      throw invalid();
    const ids = new Set<string>();
    for (const step of value.steps) {
      if (
        !step ||
        !uuid.test(step.id) ||
        ids.has(step.id) ||
        !safeText(step.note, 1000) ||
        !Number.isFinite(Date.parse(step.recordedAt)) ||
        ![
          'click',
          'double_click',
          'right_click',
          'drag',
          'scroll',
          'key',
          'type',
          'navigate',
          'back',
        ].includes(step.action)
      )
        throw invalid();
      ids.add(step.id);
      if (
        step.details &&
        (typeof step.details !== 'object' ||
          Array.isArray(step.details) ||
          Object.entries(step.details).some(
            ([key, detail]) =>
              !['x', 'y', 'toX', 'toY', 'deltaX', 'deltaY', 'key', 'destination'].includes(key) ||
              !(typeof detail === 'number' ? Number.isFinite(detail) : safeText(detail, 1000)),
          ))
      )
        throw invalid();
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536) throw invalid();
    return value;
  };
  function mark(
    kind: TeachingOperation,
    id: string,
    receipt: { expectedRevision?: string; requestId?: string } = {},
  ) {
    recovery.replace({ version: 2, id, kind, operationId: crypto.randomUUID(), ...receipt });
    publish();
  }
  function observed(value: TeachingSession, direct = false) {
    const marker = recovery.value;
    valid(value, marker?.id);
    const known =
      direct ||
      !marker ||
      marker.kind === 'idle' ||
      marker.kind === 'start' ||
      (marker.kind === 'stop' && value.status !== 'recording') ||
      (marker.kind === 'review' && value.revision !== marker.expectedRevision) ||
      (marker.kind === 'generate' && value.generationRequestId === marker.requestId) ||
      // A delayed cancel can stop a future generation; only a proposal is immutable.
      (['cancel', 'legacy'].includes(marker.kind) && value.status === 'proposed');
    if (known) mark('idle', value.id);
    else recovery.replace(marker);
    publish({ session: value, error: known ? '' : uiText('workspace:teachingUnknown') });
  }
  async function work(task: () => Promise<void>) {
    if (!current() || state.busy) return false;
    const ticket = ++sequence;
    publish({ busy: true, error: '' });
    try {
      await task();
      return current() && ticket === sequence;
    } catch (error) {
      if (current() && ticket === sequence) publish({ error: (error as Error).message });
      return false;
    } finally {
      if (current() && ticket === sequence) publish({ busy: false });
    }
  }
  const path = (suffix = '') =>
    `/teaching/${encodeURIComponent(recovery.value?.id || '')}${suffix}`;
  async function models() {
    const value = await scope.request<{ profiles: Array<Record<string, unknown>> }>(
      '/model-profiles',
    );
    if (!Array.isArray(value?.profiles)) throw invalid();
    const fields = [
      'id',
      'name',
      'provider',
      'model',
      'baseUrl',
      'vision',
      'configured',
      'hasApiKey',
      'credentialSource',
    ];
    const profiles = value.profiles
      .filter((p) => p.configured === true)
      .map((p) => {
        if (!uuid.test(String(p.id)) || typeof p.name !== 'string') throw invalid();
        return {
          id: String(p.id),
          name: p.name,
          configured: true,
          fingerprint: JSON.stringify(fields.map((field) => p[field] ?? null)),
        };
      });
    publish({ models: profiles });
  }
  async function check() {
    return work(async () => {
      recovery.load();
      loaded = true;
      publish();
      if (recovery.value) {
        try {
          observed(await scope.request<TeachingSession>(path()));
        } catch (error) {
          if (!(
            error instanceof ApiError &&
            error.status === 410 &&
            error.code === 'TEACHING_CLOSED'
          ))
            throw error;
          recovery.replace();
          recordingBinding = undefined;
          publish({ session: undefined });
        }
      }
      const values = await scope.request<TeachingSession[]>('/teaching');
      if (!Array.isArray(values) || values.length > 30) throw invalid();
      const sessions = values
        .filter((s) => s.agentId === options.agentId && s.conversationId === options.conversationId)
        .map((s) => valid(s));
      publish({ sessions });
      if (!recovery.value && sessions.length) {
        const running = sessions.filter((s) => ['recording', 'generating'].includes(s.status));
        if (running.length > 1) throw invalid();
        const selected = running[0] || sessions[0];
        const record = valid(
          await scope.request<TeachingSession>(`/teaching/${selected.id}`),
          selected.id,
        );
        observed(record);
      }
      await models();
      publish({ ready: true });
    });
  }
  async function write(kind: TeachingOperation, suffix: string, body: object, method = 'POST') {
    const id = recovery.value!.id;
    const receipt = body as { requestId?: string; expectedRevision?: string };
    mark(kind, id, {
      ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
      ...(receipt.expectedRevision ? { expectedRevision: receipt.expectedRevision } : {}),
    });
    const result = valid(await scope.request<TeachingSession>(path(suffix), method, body), id);
    if (kind === 'generate' && result.generationRequestId !== receipt.requestId) throw invalid();
    observed(result, true);
  }
  const client = {
    get state() {
      return snapshot();
    },
    current,
    resume() {
      scope.resume();
      publish({ busy: false, ready: false });
    },
    check,
    async select(id: string) {
      if (
        !state.ready ||
        !state.sessions.some((s) => s.id === id) ||
        snapshot().uncertain ||
        ['recording', 'generating'].includes(state.session?.status || '')
      )
        return false;
      return work(async () => {
        const value = valid(
          await scope.request<TeachingSession>(`/teaching/${encodeURIComponent(id)}`),
          id,
        );
        recordingBinding = undefined;
        mark('idle', id);
        publish({ session: value, error: '' });
      });
    },
    async start(leaseId: string) {
      if (!state.ready || recovery.value || state.session || !leaseId || !binding()) return false;
      return work(async () => {
        const requestId = crypto.randomUUID();
        recordingBinding = binding();
        mark('start', requestId);
        const body: StartTeaching = {
          requestId,
          agentId: options.agentId,
          conversationId: options.conversationId,
          leaseId,
        };
        observed(
          valid(await scope.request<TeachingSession>('/teaching', 'POST', body), requestId),
          true,
        );
      });
    },
    async stop() {
      if (snapshot().uncertain || state.session?.status !== 'recording') return false;
      return work(() => write('stop', '/stop', {}));
    },
    async cancel() {
      if (!loaded || !recovery.value) return false;
      return work(async () => {
        const id = recovery.value!.id;
        mark('cancel', id);
        const result = await scope.request<TeachingSession | { id: string; status: 'closed' }>(
          path('/cancel'),
          'POST',
          {},
        );
        if (result.status === 'closed') {
          if (result.id !== id) throw invalid();
          recovery.replace();
          recordingBinding = undefined;
          publish({ session: undefined });
        } else observed(valid(result, id), true);
      });
    },
    async save(review: ReviewTeaching) {
      if (
        snapshot().uncertain ||
        !state.session ||
        !['review', 'interrupted', 'error'].includes(state.session.status) ||
        review.expectedRevision !== state.session.revision
      )
        return false;
      return work(() => write('review', '', review, 'PATCH'));
    },
    async generate(profileId: string, acceptInterrupted: boolean, fingerprint?: string) {
      const session = state.session,
        selected = state.models.find((m) => m.id === profileId);
      if (
        snapshot().uncertain ||
        !session ||
        !selected ||
        (fingerprint !== undefined && selected.fingerprint !== fingerprint) ||
        !['review', 'interrupted', 'error'].includes(session.status) ||
        !session.goal.trim() ||
        !session.steps.length ||
        (session.interrupted && !acceptInterrupted)
      )
        return false;
      return work(async () => {
        await models();
        if (!state.models.some((m) => m.id === profileId && m.fingerprint === selected.fingerprint))
          throw Error(uiText('workspace:teachingModelChanged'));
        const body: GenerateTeaching = {
          requestId: crypto.randomUUID(),
          expectedRevision: session.revision,
          profileId,
          acceptInterrupted,
        };
        await write('generate', '/generate', body);
      });
    },
    newRecording() {
      if (
        !current() ||
        !state.ready ||
        state.busy ||
        ['recording', 'generating'].includes(state.session?.status || '') ||
        snapshot().uncertain
      )
        return;
      try {
        recovery.replace();
        recordingBinding = undefined;
        publish({ session: undefined, error: '' });
      } catch (error) {
        publish({ error: (error as Error).message });
      }
    },
    bindingChanged() {
      publish();
      if (
        state.session?.status === 'recording' &&
        recordingBinding &&
        binding() !== recordingBinding
      )
        void client.cancel();
    },
    async skillRequest(path: string, body: unknown) {
      if (!current()) throw new DOMException('View expired', 'AbortError');
      return scope.request(path, 'POST', body);
    },
    close() {
      const id = recovery.value?.id;
      const active =
        ['recording', 'generating'].includes(state.session?.status || '') || snapshot().uncertain;
      sequence++;
      // Persist the cleanup fence before sending; an unconfirmed reply stays blocked after remount.
      if (id && active) {
        try {
          mark('cancel', id);
          void (options.fetch || fetch)(
            `/api/workspaces/${encodeURIComponent(options.workspaceId!)}/teaching/${encodeURIComponent(id)}/cancel`,
            {
              method: 'POST',
              credentials: 'same-origin',
              keepalive: true,
              headers: {
                'Content-Type': 'application/json',
                'X-OpenBot-Expected-User': options.userId!,
              },
              body: '{}',
            },
          ).catch(() => {});
        } catch {
          /* A newer view owns this recovery slot. */
        }
      }
      scope.suspend();
    },
  };
  return client;
}
