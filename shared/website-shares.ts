export const websiteVisibilities = ['private', 'invited', 'team', 'public'] as const;
export type WebsiteVisibility = (typeof websiteVisibilities)[number];
export type WebsiteShare = {
  visibility: WebsiteVisibility;
  revision: string | null;
  versionId: string | null;
  viewerIds: string[];
  path: string | null;
};

const pageToken = /^[a-zA-Z0-9_-]{43}$/;
const versionId = /^[a-f0-9]{64}$/;
const identity = /^[a-zA-Z0-9_-]{1,128}$/;
export const websiteSharePath = (token: string) => (pageToken.test(token) ? `/pages/${token}` : '');
export const parseWebsiteSharePath = (path: string) =>
  /^\/pages\/([a-zA-Z0-9_-]{43})\/?$/.exec(path)?.[1];

export function parseWebsiteShare(value: unknown): WebsiteShare | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const {
    visibility,
    revision,
    versionId: version,
    viewerIds,
    path,
  } = value as Record<string, unknown>;
  if (
    !websiteVisibilities.includes(visibility as WebsiteVisibility) ||
    !(revision === null || (typeof revision === 'string' && identity.test(revision))) ||
    !(version === null || (typeof version === 'string' && versionId.test(version))) ||
    !Array.isArray(viewerIds) ||
    viewerIds.length > 100 ||
    viewerIds.some((id) => typeof id !== 'string' || !identity.test(id)) ||
    new Set(viewerIds).size !== viewerIds.length
  )
    return undefined;
  if (visibility === 'private') {
    if (path !== null) return undefined;
  } else if (!version || !revision || typeof path !== 'string' || !parseWebsiteSharePath(path)) {
    return undefined;
  }
  return {
    visibility: visibility as WebsiteVisibility,
    revision: revision as string | null,
    versionId: version as string | null,
    viewerIds: [...viewerIds],
    path: path as string | null,
  };
}
