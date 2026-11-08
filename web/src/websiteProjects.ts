import type { Message } from '../../shared/types';
import { readBoundedBody } from './filePreview';
import { currentWorkspaceId } from './workspace-scope';

const versionId = /^[a-f0-9]{64}$/;
const workspaceId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const maxFileBytes = 4 * 1024 * 1024;
const maxTotalBytes = 10 * 1024 * 1024;
const maxFileCount = 64;
const mediaTypes = new Set([
  'text/html',
  'text/css',
  'text/javascript',
  'text/plain',
  'text/csv',
  'application/json',
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'font/woff',
  'font/woff2',
]);

export type WebsiteProjectSummary = {
  id: string;
  projectKey: string;
  title: string;
  entry: string;
  fileCount: number;
  totalBytes: number;
};
export type WebsiteProjectFile = { path: string; mime: string; bytes: Uint8Array<ArrayBuffer> };
type WebsiteAsset = { path: string; mime: string; sha256: string; size: number };
export type WebsiteProjectViewState =
  { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; files: WebsiteProjectFile[] };
export type OpenWebsiteProject = (message: Message) => void;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > 240) return false;
  const parts = value.split('/');
  return (
    parts.length <= 12 &&
    parts.every((part) => /^[a-z0-9_-][a-z0-9_.-]{0,79}$/i.test(part) && !part.endsWith('.'))
  );
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function parseWebsiteProject(value: unknown): WebsiteProjectSummary | undefined {
  const project = record(value);
  if (!project) return;
  const { id, projectKey, title, entry, fileCount, totalBytes } = project;
  if (
    typeof id === 'string' &&
    versionId.test(id) &&
    typeof projectKey === 'string' &&
    versionId.test(projectKey) &&
    typeof title === 'string' &&
    title.trim() &&
    title.length <= 100 &&
    isPath(entry) &&
    /\.html?$/i.test(entry) &&
    boundedInteger(fileCount, 1, maxFileCount) &&
    boundedInteger(totalBytes, 0, maxTotalBytes)
  )
    return { id, projectKey, title, entry, fileCount, totalBytes };
}

export function websiteProjectFor(message: Message) {
  return message.kind === 'website_project' && message.role === 'assistant'
    ? parseWebsiteProject(message.metadata?.websiteProject)
    : undefined;
}

export function projectManifest(expected: WebsiteProjectSummary, value: unknown): WebsiteAsset[] {
  const manifest = record(value);
  const summary = parseWebsiteProject(manifest);
  if (
    !manifest ||
    !summary ||
    Object.keys(expected).some(
      (key) =>
        summary[key as keyof WebsiteProjectSummary] !==
        expected[key as keyof WebsiteProjectSummary],
    ) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== summary.fileCount
  )
    throw Error('Invalid website project manifest');
  const names = new Set<string>();
  let total = 0;
  const assets = manifest.files.map((file: unknown) => {
    const entry = record(file);
    if (
      !entry ||
      !isPath(entry.path) ||
      typeof entry.mime !== 'string' ||
      !mediaTypes.has(entry.mime) ||
      typeof entry.sha256 !== 'string' ||
      !versionId.test(entry.sha256) ||
      !boundedInteger(entry.size, 0, maxFileBytes) ||
      names.has(entry.path.toLowerCase())
    )
      throw Error('Invalid website project file');
    names.add(entry.path.toLowerCase());
    total += entry.size;
    return { path: entry.path, mime: entry.mime, sha256: entry.sha256, size: entry.size };
  });
  if (
    total !== summary.totalBytes ||
    !assets.some((file) => file.path === summary.entry && file.mime === 'text/html')
  )
    throw Error('Invalid website project assets');
  return assets;
}

export async function loadWebsiteProjectAssets(
  files: WebsiteAsset[],
  read: (path: string, size: number) => Promise<Uint8Array<ArrayBuffer>>,
  check: () => void,
): Promise<WebsiteProjectFile[]> {
  const loaded: WebsiteProjectFile[] = [];
  for (let start = 0; start < files.length; start += 4) {
    const batch = await Promise.all(
      files.slice(start, start + 4).map(async ({ path, mime, size, sha256 }) => {
        const body = await read(path, size);
        const checksum = await crypto.subtle.digest('SHA-256', body);
        check();
        if (
          body.length !== size ||
          Array.from(new Uint8Array(checksum), (byte) => byte.toString(16).padStart(2, '0')).join(
            '',
          ) !== sha256
        )
          throw Error('Website project checksum mismatch');
        return { path, mime, bytes: body };
      }),
    );
    loaded.push(...batch);
  }
  return loaded;
}

export async function readWebsiteProjectResponse(
  response: Response,
  mime: string,
  limit: number,
  check: () => void,
) {
  check();
  if (
    !response.ok ||
    response.redirected ||
    response.headers.get('Content-Type')?.split(';')[0] !== mime ||
    (mime !== 'application/json' &&
      !/^attachment(?:;|$)/i.test(response.headers.get('Content-Disposition') || ''))
  ) {
    await response.body?.cancel().catch(() => {});
    throw Error('Website project response unavailable');
  }
  return readBoundedBody(response, limit, check);
}

type ProjectAccess = { workspaceId: string; userId: string; current: () => boolean };
export function websiteProjectClient(project: WebsiteProjectSummary, access: ProjectAccess) {
  const root = `/api/workspaces/${access.workspaceId}/website-projects/${project.id}`;
  function check(signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      !workspaceId.test(access.workspaceId) ||
      !versionId.test(project.id) ||
      !access.userId ||
      currentWorkspaceId() !== access.workspaceId ||
      !access.current()
    )
      throw new DOMException('The website project scope changed', 'AbortError');
  }

  async function read(path: string, mime: string, limit: number, signal: AbortSignal) {
    check(signal);
    const response = await fetch(root + path, {
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: { 'X-OpenBot-Expected-User': access.userId },
    });
    return readWebsiteProjectResponse(response, mime, limit, () => check(signal));
  }

  return {
    async load(signal: AbortSignal): Promise<WebsiteProjectFile[]> {
      const bytes = await read('', 'application/json', 64 * 1024, signal);
      const files = projectManifest(
        project,
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
      return loadWebsiteProjectAssets(
        files,
        (path, size) => read(`/files/${path}`, 'application/octet-stream', size, signal),
        () => check(signal),
      );
    },
    async download(signal: AbortSignal) {
      const bytes = await read(
        '/download',
        'application/zip',
        project.totalBytes + 128 * 1024,
        signal,
      );
      check(signal);
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4)
        throw Error('Invalid website project ZIP');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `website-${project.id.slice(0, 12)}.zip`;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    },
  };
}
