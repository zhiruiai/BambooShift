import { ApiError } from './api';
import { createPrimaryBotScope, type PrimaryBotIdentity } from './primaryBot';

export type RoutineWebhookConfig =
  { enabled: false; revision: string } | { enabled: true; revision: string; path: string };

export type RoutineWebhookState = {
  busy: boolean;
  config?: RoutineWebhookConfig;
  secret?: string;
  notice?: 'changed' | 'unknown' | 'readFailed' | 'revoked';
};

type Options = PrimaryBotIdentity & {
  routineId: string;
  identity: () => PrimaryBotIdentity;
  locationWorkspace?: () => string | undefined;
  fetch?: typeof fetch;
  canReveal?: () => boolean;
  onState: (state: RoutineWebhookState) => void;
};

const revisionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;

export function routineWebhookEndpoint(workspaceId: string | undefined, routineId: string) {
  if (
    workspaceId?.length === 36 &&
    revisionId.test(workspaceId) &&
    routineId.length > 0 &&
    routineId.length <= 160 &&
    !/[^A-Za-z0-9_-]/.test(routineId)
  )
    return `/api/routine-webhooks/${workspaceId}/${routineId}`;
}

/** The caller holds a one-time key in memory only for the exact view that requested it. */
export function createRoutineWebhookClient(options: Options) {
  const scope = createPrimaryBotScope(options);
  const path = `/routines/${encodeURIComponent(options.routineId)}/webhook`;
  const endpoint = routineWebhookEndpoint(options.workspaceId, options.routineId);
  let state: RoutineWebhookState = { busy: false };
  let secretGeneration = 0;
  const current = (ticket: number) => !!endpoint && !!options.userId && scope.current(ticket);
  const publish = (patch: Partial<RoutineWebhookState>) => {
    state = { ...state, ...patch };
    if (current(scope.ticket())) options.onState(state);
  };

  function readConfig(value: unknown): RoutineWebhookConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    const { enabled, revision, path } = value as Record<string, unknown>;
    if (
      typeof revision !== 'string' ||
      !((revision.length === 36 && revisionId.test(revision)) || (!enabled && revision === 'unset'))
    )
      throw Error();
    if (enabled === true && endpoint && path === endpoint) return { enabled, revision, path };
    if (enabled === false && path === undefined) return { enabled, revision };
    throw Error();
  }

  async function fetchConfig() {
    const value = await scope.request<Record<string, unknown>>(path);
    if (value?.secret !== undefined) throw Error();
    return readConfig(value);
  }

  function discardSecret() {
    secretGeneration++;
    if (state.secret !== undefined) publish({ secret: undefined });
  }

  async function read() {
    const ticket = scope.ticket();
    if (!current(ticket) || state.busy) return;
    discardSecret();
    publish({ busy: true, config: undefined, notice: undefined });
    try {
      const config = await fetchConfig();
      if (current(ticket)) publish({ config });
    } catch {
      if (current(ticket)) publish({ notice: 'readFailed' });
    } finally {
      if (current(ticket)) publish({ busy: false });
    }
  }

  async function write(method: 'PUT' | 'DELETE', expectedRevision: string) {
    const ticket = scope.ticket();
    if (
      !current(ticket) ||
      state.busy ||
      state.config?.revision !== expectedRevision ||
      (method === 'DELETE' && !state.config.enabled)
    )
      return;
    discardSecret();
    const generation = secretGeneration;
    publish({ busy: true, notice: undefined });
    try {
      const value = await scope.request<Record<string, unknown>>(path, method, {
        expectedRevision,
      });
      if (!current(ticket)) return;
      const config = readConfig(value);
      if (config.revision === expectedRevision || config.revision === 'unset') throw Error();
      if (method === 'PUT') {
        const secret = value.secret;
        if (
          !config.enabled ||
          typeof secret !== 'string' ||
          secret.length !== 43 ||
          !secretPattern.test(secret)
        )
          throw Error();
        publish({
          config,
          secret:
            generation === secretGeneration && (options.canReveal?.() ?? true) ? secret : undefined,
        });
      } else {
        if (config.enabled || value.secret !== undefined) throw Error();
        publish({ config, notice: 'revoked' });
      }
    } catch (error) {
      if (!current(ticket)) return;
      const notice =
        error instanceof ApiError && error.code === 'ROUTINE_WEBHOOK_CHANGED'
          ? 'changed'
          : 'unknown';
      publish({ config: undefined, notice });
      // A lost response may already have changed the key. Read current status without replaying.
      try {
        const config = await fetchConfig();
        if (current(ticket)) publish({ config });
      } catch {
        // Without a confirmed revision the view keeps all mutations disabled.
      }
    } finally {
      if (current(ticket)) publish({ busy: false });
    }
  }

  return {
    read,
    write,
    discardSecret,
    current: () => current(scope.ticket()),
    resume: scope.resume,
    suspend() {
      scope.suspend();
      secretGeneration++;
      state = { busy: false };
    },
  };
}
