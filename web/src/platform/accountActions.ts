import { uiText } from '../i18n';
import { PlatformApiError, platformApi } from './platformApi';
export type MutationGate = { busy: boolean; begin: () => boolean; finish: () => void };

export function passwordProblem(current: string, next: string, confirmation: string): string {
  if (!current || current.length > 128) return uiText('account:text_9844bcd129ba');
  if (next.length < 10 || next.length > 128) return uiText('account:text_0c2117e31eb5');
  if (next === current) return uiText('account:text_fd38d4fd462b');
  return next === confirmation ? '' : uiText('account:text_a2ba2545a60e');
}

/** A lost response cannot prove a password update failed. Never retry it automatically. */
export async function submitPasswordChange(
  input: { expectedUserId: string; currentPassword: string; newPassword: string },
  request: typeof platformApi = platformApi,
): Promise<'changed' | 'unknown'> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    await request('/account/password', 'POST', input, { signal: controller.signal });
    return 'changed';
  } catch (error) {
    if (
      controller.signal.aborted ||
      !(error instanceof PlatformApiError) ||
      error.status === 0 ||
      error.status === 408 ||
      error.status >= 500
    )
      return 'unknown';
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
