import { uiText } from '../i18n';
import type { AccountSession, WorkspaceSummary } from '../../../shared/platform';
import {
  BOT_TEMPLATE_TOKEN,
  type PublishedBotTemplate,
  type TemplateSharingMode,
  type TemplateSharingPolicy,
} from '../../../shared/bot-templates';
import type { TemplateScope } from '../botTemplates';
import { PlatformApiError } from './platformApi';

export const templateImportTargets = (session?: AccountSession) =>
  session?.authenticated && session.user?.status === 'active'
    ? session.workspaces.filter(
        (workspace) => workspace.role === 'owner' && workspace.status === 'active',
      )
    : [];
export const sharingModes = (kind: WorkspaceSummary['kind']): TemplateSharingMode[] =>
  kind === 'personal' ? ['public', 'disabled'] : ['public', 'team-only', 'disabled'];

export interface TemplatePageState {
  loading: boolean;
  session?: AccountSession;
  preview?: PublishedBotTemplate;
  error: string;
}
/** Public links are anonymous unless a freshly read account is explicitly pinned. */
export function createTemplatePageReader(options: {
  token: string;
  fetch?: typeof fetch;
  current?: () => boolean;
  onChange?: (state: TemplatePageState) => void;
}) {
  let active = true,
    sequence = 0,
    controller: AbortController | undefined;
  let state: TemplatePageState = { loading: false, error: '' };
  const publish = (patch: Partial<TemplatePageState>) => {
    state = { ...state, ...patch };
    if (active) options.onChange?.(state);
  };
  const current = (ticket: number) =>
    active && sequence === ticket && (options.current?.() ?? true);
  const request = async <T>(path: string, signal: AbortSignal, userId?: string): Promise<T> => {
    const response = await (options.fetch || fetch)(`/api${path}`, {
      signal,
      cache: 'no-store',
      credentials: path === '/account/session' || userId ? 'same-origin' : 'omit',
      headers: userId ? { 'X-OpenBot-Expected-User': userId } : undefined,
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new PlatformApiError(
        value.error || uiText('account:text_4496f7f115d1'),
        response.status,
      );
    return value as T;
  };
  return {
    get state() {
      return state;
    },
    resume() {
      active = true;
    },
    suspend() {
      active = false;
      sequence++;
      controller?.abort();
    },
    async read() {
      if (!active || !(options.current?.() ?? true)) return;
      const ticket = ++sequence;
      controller?.abort();
      controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      publish({ loading: true, error: '' });
      try {
        if (!BOT_TEMPLATE_TOKEN.test(options.token))
          throw new Error(uiText('account:text_2d0dc1cb4647'));
        const session = await request<AccountSession>('/account/session', signal);
        if (!current(ticket)) return;
        if (session.authenticated && (!session.user || session.user.status !== 'active'))
          throw new Error(uiText('account:text_8bcf7af567bb'));
        const userId = session.authenticated ? session.user!.id : undefined;
        publish({ session, ...(state.session?.user?.id !== userId ? { preview: undefined } : {}) });
        const preview = await request<PublishedBotTemplate>(
          `/bot-template-links/${options.token}`,
          signal,
          userId,
        );
        if (!current(ticket)) return;
        if (
          preview.token !== options.token ||
          !preview.revision ||
          preview.blueprint?.version !== 1
        )
          throw new Error(uiText('account:text_0b5dc53b52ee'));
        publish({ preview, error: '' });
      } catch (cause) {
        if (current(ticket))
          publish({
            preview: undefined,
            error: (cause as Error).message || uiText('account:text_69c9349b0bb0'),
          });
      } finally {
        if (current(ticket)) publish({ loading: false });
      }
    },
  };
}

export interface SharingPolicyState {
  policy?: TemplateSharingPolicy;
  selection?: TemplateSharingMode;
  loading: boolean;
  busy: boolean;
  needsRefresh: boolean;
  error: string;
  notice: string;
}
export function createSharingPolicyEditor(options: {
  scope: TemplateScope;
  kind: WorkspaceSummary['kind'];
  onChange?: (state: SharingPolicyState) => void;
}) {
  let active = true,
    working = false;
  let state: SharingPolicyState = {
    loading: false,
    busy: false,
    needsRefresh: false,
    error: '',
    notice: '',
  };
  const publish = (patch: Partial<SharingPolicyState>) => {
    state = { ...state, ...patch };
    if (active) options.onChange?.(state);
  };
  const current = (ticket: number) => active && options.scope.current(ticket);
  return {
    get state() {
      return state;
    },
    resume() {
      active = true;
    },
    suspend() {
      active = false;
    },
    choose(mode: TemplateSharingMode) {
      if (!working && sharingModes(options.kind).includes(mode))
        publish({ selection: mode, notice: '' });
    },
    async read() {
      const ticket = options.scope.ticket();
      if (working || !current(ticket)) return;
      working = true;
      publish({ loading: true, error: '' });
      try {
        const preserveSelection =
          state.selection !== undefined &&
          (state.needsRefresh || state.selection !== state.policy?.mode);
        const policy = await options.scope.request<TemplateSharingPolicy>('/bot-sharing-policy');
        if (current(ticket))
          publish({
            policy,
            selection: preserveSelection ? state.selection : policy.mode,
            needsRefresh: false,
            notice: state.needsRefresh ? uiText('account:text_ef42d32f8ce3') : '',
          });
      } catch (cause) {
        if (current(ticket)) publish({ error: (cause as Error).message });
      } finally {
        working = false;
        if (current(ticket)) publish({ loading: false });
      }
    },
    async save() {
      const ticket = options.scope.ticket(),
        { policy, selection } = state;
      if (
        working ||
        !current(ticket) ||
        !policy ||
        !selection ||
        state.needsRefresh ||
        selection === policy.mode ||
        !sharingModes(options.kind).includes(selection)
      )
        return;
      working = true;
      publish({ busy: true, error: '', notice: '' });
      try {
        const result = await options.scope.request<TemplateSharingPolicy>(
          '/bot-sharing-policy',
          'PUT',
          { expectedRevision: policy.revision, mode: selection },
        );
        if (current(ticket))
          publish({
            policy: result,
            selection: result.mode,
            notice: uiText('account:text_81008c286fe7'),
          });
      } catch (cause) {
        if (current(ticket))
          publish({
            needsRefresh: true,
            error: uiText('account:text_b50bdf0719b0', { value0: (cause as Error).message }),
          });
      } finally {
        working = false;
        if (current(ticket)) publish({ busy: false });
      }
    },
  };
}
