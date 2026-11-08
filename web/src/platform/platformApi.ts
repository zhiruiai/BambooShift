import { uiText, languageHeaders, currentLanguage } from '../i18n';
import { parseAppAuthorizationPath } from '../appOAuth';
import { parseBotTemplatePath, botTemplatePath } from '../../../shared/bot-templates';
import { parseSharedBotPath } from '../../../shared/shared-bots';
import { parseTeamSkillLinkPath } from '../../../shared/team-skills';
import { parseWebsiteSharePath, websiteSharePath } from '../../../shared/website-shares';

export class PlatformApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

/** Account/operator requests never inherit the selected product workspace. */
export async function platformApi<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  options?: { signal?: AbortSignal; expectedUser?: string },
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new Error(uiText('account:text_62a87510ae32'));
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...languageHeaders(),
        ...(options?.expectedUser ? { 'X-OpenBot-Expected-User': options.expectedUser } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options?.signal,
    });
  } catch {
    throw new PlatformApiError(uiText('account:text_6869ca73bffe'), 0);
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const entry = /^\/(account\/(login|register)|platform\/(login|setup))$/.test(path);
    if (response.status === 401 && !entry && !options?.signal?.aborted) {
      window.dispatchEvent(
        new Event(
          path.startsWith('/platform/') ? 'openbot:operator-expired' : 'openbot:account-expired',
        ),
      );
    }
    if (
      response.status === 403 &&
      !options?.signal?.aborted &&
      /^\/account\/workspaces(?:\/|$)/.test(path)
    )
      window.dispatchEvent(new Event('openbot:revalidate'));
    throw new PlatformApiError(
      result.error ||
        result.message ||
        uiText('account:text_2db365459643', { value0: response.status }),
      response.status,
      result.code,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export const workspacePath = (id: string) => `/w/${encodeURIComponent(id)}`;
export function safeAccountNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '';
  if (value.startsWith('/team-skills/')) return parseTeamSkillLinkPath(value) ? value : '';
  if (value.startsWith('/app-authorize/')) return parseAppAuthorizationPath(value) ? value : '';
  if (value.startsWith('/shared-bots/')) return parseSharedBotPath(value) ? value : '';
  if (value.startsWith('/pages/')) {
    const token = parseWebsiteSharePath(value);
    return token ? websiteSharePath(token) : '';
  }
  if (value.startsWith('/templates/')) {
    const token = parseBotTemplatePath(value);
    return token ? botTemplatePath(token)! : '';
  }
  try {
    const base = 'https://openbot.invalid';
    const url = new URL(value, base);
    if (
      url.origin !== base ||
      !/^\/(account|invite\/[^/]+|w\/[^/]+(?:\/(?:manage|members))?)\/?$/.test(url.pathname)
    )
      return '';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '';
  }
}
export function accountEntryPath(mode: 'login' | 'register', next?: string) {
  const safe = safeAccountNext(next);
  return `/${mode}${safe ? `?next=${encodeURIComponent(safe)}` : ''}`;
}
export function platformTime(value?: string) {
  if (!value) return uiText('account:text_46ca86da52b3');
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? uiText('account:text_664939a1fa2e')
    : date.toLocaleString(currentLanguage(), { hour12: false });
}
