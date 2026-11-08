import { uiText } from './i18n';
import type { Bootstrap, BotAgent, Conversation } from '../../shared/types';
import type { BotBlueprint, BotInstallReceipt } from '../../shared/bot-blueprint';
import {
  BOT_TEMPLATE_TOKEN,
  parseBotTemplatePath,
  type BotTemplateCard,
} from '../../shared/bot-templates';
import { createAppConnectionScope } from './appConnections';
import { ApiError } from './api';

export type TemplateIdentity = { workspaceId?: string; userId?: string };
export type TemplateScope = ReturnType<typeof createBotTemplateScope>;
export type BotCopySource = {
  sourceRevision: string;
  blueprint: BotBlueprint;
  avatarPath?: string;
};
export type RoutineInstallMode = 'preserve' | 'pause';
export type ConfirmedBotInstall = { agent: BotAgent; conversation: Conversation };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function createBotTemplateScope(
  options: TemplateIdentity & {
    identity: () => TemplateIdentity;
    fetch?: typeof fetch;
    locationPath?: () => string;
  },
) {
  const pathname =
      options.locationPath ||
      (() => (typeof window === 'undefined' ? '' : window.location.pathname)),
    opened = pathname();
  const same = () => {
    const current = options.identity();
    return (
      current.workspaceId === options.workspaceId &&
      current.userId === options.userId &&
      pathname() === opened
    );
  };
  const scope = createAppConnectionScope({
    ...options,
    onAuthFailure: (status) => {
      if (!same() || !scope.current(scope.ticket()) || typeof window === 'undefined') return;
      window.dispatchEvent(
        new Event(
          status === 403
            ? 'openbot:revalidate'
            : options.userId
              ? 'openbot:account-expired'
              : 'openbot:unpaired',
        ),
      );
    },
    fetch: (url, init) => {
      if (!same()) throw new DOMException(uiText('bots:text_b8517ac1992f'), 'AbortError');
      return (options.fetch || fetch)(url, init);
    },
  });
  return { ...scope, current: (ticket: number) => scope.current(ticket) && same() };
}
export const cloneBlueprint = (value: BotBlueprint): BotBlueprint =>
  JSON.parse(JSON.stringify(value));
export function safeTemplateAvatarPath(path: unknown): string | undefined {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/api/') ||
    path.includes('\\') ||
    /[#%]/.test(path)
  )
    return;
  const url = new URL(path, 'https://openbot.invalid');
  const keys = [...url.searchParams.keys()];
  if (
    keys.length > 1 ||
    (keys.length === 1 &&
      (keys[0] !== 'revision' || !/^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get('revision')!)))
  )
    return;
  if (
    /^\/api\/(?:workspaces\/[a-f0-9-]{36}\/)?bot-templates\/[a-f0-9-]{36}\/avatar$/.test(
      url.pathname,
    ) ||
    /^\/api\/bot-template-links\/[A-Za-z0-9_-]{43}\/avatar$/.test(url.pathname) ||
    /^\/api\/(?:workspaces\/[a-f0-9-]{36}\/)?bot-avatars\/[a-f0-9-]{36}$/.test(url.pathname) ||
    /^\/api\/(?:workspaces\/[a-f0-9-]{36}\/)?bot-copy-source\/[A-Za-z0-9_-]{1,80}\/avatar$/.test(
      url.pathname,
    )
  )
    return path;
}
export async function fetchBotTemplateAvatar(
  path: string,
  identity: TemplateIdentity,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  const safe = safeTemplateAvatarPath(path);
  if (!safe) throw new Error(uiText('bots:text_c150f1eca143'));
  const privatePath = /^\/api\/workspaces\/([^/]+)\//.exec(safe);
  if (privatePath && privatePath[1] !== identity.workspaceId)
    throw new Error(uiText('bots:text_3d5324373aa6'));
  const response = await transport(safe, {
    signal,
    cache: 'no-store',
    credentials:
      identity.userId || !safe.startsWith('/api/bot-template-links/') ? 'same-origin' : 'omit',
    headers: identity.userId ? { 'X-OpenBot-Expected-User': identity.userId } : undefined,
  });
  if (!response.ok || !/^image\/webp(?:;|$)/i.test(response.headers.get('Content-Type') || ''))
    throw new Error(uiText('bots:text_b819a19559d8'));
  const blob = await response.blob();
  if (blob.size > 2 * 1024 * 1024) throw new Error(uiText('bots:text_09f928de94b8'));
  return blob;
}
export function parseBotTemplateCard(value: unknown): BotTemplateCard | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as BotTemplateCard;
  if (
    !uuid.test(item.templateId) ||
    !Number.isSafeInteger(item.sequence) ||
    item.sequence < 0 ||
    typeof item.name !== 'string' ||
    item.name.length > 40 ||
    !['draft', 'published', 'revoked'].includes(item.status)
  )
    return;
  if (item.audience !== undefined && !['public', 'team'].includes(item.audience)) return;
  if (
    item.path !== undefined &&
    (typeof item.path !== 'string' || !parseBotTemplatePath(item.path))
  )
    return;
  return item;
}
export async function confirmBotInstall(
  scope: Pick<TemplateScope, 'request'>,
  receipt: BotInstallReceipt,
): Promise<ConfirmedBotInstall> {
  const data = await scope.request<Bootstrap>('/bootstrap');
  const agent = data.agents.find((value) => value.id === receipt.agentId),
    conversation = data.conversations.find(
      (value) =>
        value.id === receipt.conversationId &&
        !value.isGroup &&
        value.agentIds.length === 1 &&
        value.agentIds[0] === receipt.agentId,
    );
  if (!agent || !conversation) throw new Error(uiText('bots:text_dad5911210ef'));
  return { agent, conversation };
}
export type BotInstallInput =
  | {
      kind: 'copy';
      agentId: string;
      expectedSourceRevision: string;
      name: string;
      routineMode: RoutineInstallMode;
    }
  | {
      kind: 'import';
      token: string;
      expectedRevision: string;
      name: string;
      routineMode: RoutineInstallMode;
    };
export type BotInstallAttempt = BotInstallInput & { requestId: string };
export function definiteTemplateRejection(
  cause: unknown,
  kind: 'install' | 'template',
): cause is ApiError {
  return (
    cause instanceof ApiError &&
    cause.status >= 400 &&
    cause.status < 500 &&
    ![401, 403, 408].includes(cause.status) &&
    cause.code === (kind === 'install' ? 'BOT_INSTALL_NOT_STARTED' : 'BOT_TEMPLATE_NOT_APPLIED')
  );
}
export type BotInstallerState = {
  busy: boolean;
  attempt?: BotInstallAttempt;
  checked: boolean;
  error: string;
  receipt?: BotInstallReceipt;
  confirmed?: ConfirmedBotInstall;
};
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function restoreAttempt(
  value: string | null,
  kind: BotInstallInput['kind'],
): BotInstallAttempt | undefined {
  try {
    const item = JSON.parse(value || 'null');
    if (
      !item ||
      item.kind !== kind ||
      !uuid.test(item.requestId) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 40 ||
      !['preserve', 'pause'].includes(item.routineMode)
    )
      return;
    if (
      kind === 'copy' &&
      (typeof item.agentId !== 'string' ||
        !item.agentId ||
        typeof item.expectedSourceRevision !== 'string' ||
        !item.expectedSourceRevision)
    )
      return;
    if (
      kind === 'import' &&
      (!BOT_TEMPLATE_TOKEN.test(item.token) ||
        typeof item.expectedRevision !== 'string' ||
        !item.expectedRevision)
    )
      return;
    return item;
  } catch {
    return;
  }
}
/** Keeps unknown installations attached to one immutable request, even after reopening the page. */
export function createBotInstaller(options: {
  scope: TemplateScope;
  kind: BotInstallInput['kind'];
  storageKey: string;
  storage?: Store;
  onChange?: (state: BotInstallerState) => void;
}) {
  let store = options.storage;
  try {
    store ||= typeof window !== 'undefined' ? window.sessionStorage : undefined;
  } catch {}
  let restored: BotInstallAttempt | undefined;
  try {
    restored = restoreAttempt(store?.getItem(options.storageKey) || null, options.kind);
  } catch {}
  let active = true,
    running = false;
  let state: BotInstallerState = {
    busy: false,
    attempt: restored,
    checked: false,
    error: restored ? uiText('bots:text_961adea927a9') : '',
  };
  const publish = (patch: Partial<BotInstallerState>) => {
    state = { ...state, ...patch };
    if (active) options.onChange?.(state);
  };
  const persist = (attempt?: BotInstallAttempt) => {
    try {
      if (attempt) {
        if (!store) return false;
        store.setItem(options.storageKey, JSON.stringify(attempt));
      } else store?.removeItem(options.storageKey);
      return true;
    } catch {
      return false;
    }
  };
  const current = (ticket: number) => active && options.scope.current(ticket);
  const route = options.kind === 'copy' ? '/bot-copies' : '/bot-template-imports';
  async function accept(receipt: BotInstallReceipt, ticket: number) {
    if (!current(ticket)) return;
    publish({ receipt });
    const confirmed = await confirmBotInstall(options.scope, receipt);
    if (!current(ticket)) return;
    persist();
    publish({ confirmed, error: '', attempt: undefined, checked: false });
  }
  async function work(mode: 'post' | 'check') {
    const ticket = options.scope.ticket(),
      attempt = state.attempt;
    if (!current(ticket) || running || (!attempt && !state.receipt) || state.confirmed) return;
    running = true;
    publish({ busy: true, error: '' });
    try {
      if (state.receipt) {
        await accept(state.receipt, ticket);
        return;
      }
      const { kind: _, ...body } = attempt!;
      const receipt = await options.scope.request<BotInstallReceipt>(
        mode === 'post' ? route : `${route}/${encodeURIComponent(attempt!.requestId)}`,
        mode === 'post' ? 'POST' : 'GET',
        mode === 'post' ? body : undefined,
      );
      if (receipt.requestId !== attempt!.requestId)
        throw new Error(uiText('bots:text_f8a5020f3ed3'));
      await accept(receipt, ticket);
    } catch (cause) {
      if (!current(ticket)) return;
      if (mode === 'check' && cause instanceof ApiError && cause.status === 404)
        publish({
          checked: true,
          error: uiText('bots:text_69ec6519532e'),
        });
      else if (mode === 'post' && !state.receipt && definiteTemplateRejection(cause, 'install')) {
        persist();
        publish({ attempt: undefined, checked: false, error: cause.message });
      } else
        publish({
          error: (cause as Error).message || uiText('bots:text_da52080dd05a'),
          checked: false,
        });
    } finally {
      running = false;
      if (current(ticket)) publish({ busy: false });
    }
  }
  return {
    get state() {
      return state;
    },
    async start(input: BotInstallInput) {
      if (
        !current(options.scope.ticket()) ||
        running ||
        state.attempt ||
        state.receipt ||
        input.kind !== options.kind
      )
        return;
      const attempt = { ...input, requestId: crypto.randomUUID() };
      if (!persist(attempt)) {
        publish({ error: uiText('bots:text_944b159ee70d') });
        return;
      }
      publish({ attempt, checked: false });
      await work('post');
    },
    check: () => work('check'),
    retry: () => (state.checked ? work('post') : Promise.resolve()),
    resume() {
      active = true;
    },
    suspend() {
      active = false;
    },
  };
}
