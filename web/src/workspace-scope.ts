export function currentWorkspaceId() {
  if (typeof window === 'undefined') return undefined;
  return /^\/w\/([a-f0-9-]{36})(?:\/|$)/.exec(window.location.pathname)?.[1];
}
export function workspaceUrl(path = '/') {
  const id = currentWorkspaceId();
  return id ? `/w/${encodeURIComponent(id)}${path.startsWith('/') ? path : '/' + path}` : path;
}
export const conversationHref = (id: string, messageId?: string) =>
  workspaceUrl(
    `/?conversation=${encodeURIComponent(id)}${messageId ? `&message=${encodeURIComponent(messageId)}` : ''}`,
  );
export function workspaceApiUrl(path: string) {
  if (!path.startsWith('/api/') || path.startsWith('/api/workspaces/')) return path;
  const id = currentWorkspaceId();
  return id ? `/api/workspaces/${encodeURIComponent(id)}${path.slice(4)}` : path;
}
