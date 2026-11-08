import { uiText, languageHeaders } from './i18n';
import { currentWorkspaceId, workspaceApiUrl } from './workspace-scope';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function api<T = unknown>(
  path: string,
  method = 'GET',
  body?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(workspaceApiUrl(`/api${path}`), {
      method,
      credentials: 'same-origin',
      headers: {
        ...languageHeaders(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: requestBody,
      signal: options?.signal,
    });
  } catch (error) {
    if (error instanceof TypeError)
      throw new ApiError(uiText('common:text_95f9cfeae5a8'), 0, 'NETWORK_ERROR');
    throw error;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401)
      window.dispatchEvent(
        new Event(currentWorkspaceId() ? 'openbot:account-expired' : 'openbot:unpaired'),
      );
    if (res.status === 403 && currentWorkspaceId())
      window.dispatchEvent(new Event('openbot:revalidate'));
    throw new ApiError(
      data.error || data.message || uiText('common:text_c8d0b7d4cd0d', { value0: res.status }),
      res.status,
      data.code,
    );
  }
  return res.status === 204 ? (undefined as T) : res.json();
}
export async function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error(uiText('common:text_d9851374e355')));
    r.readAsDataURL(file);
  });
}
