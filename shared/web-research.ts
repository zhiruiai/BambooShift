import type { Message } from './types';

const researchIssues = [
  'search_task_limit',
  'search_retry_limit',
  'fetch_task_limit',
  'upstream_rate_limit',
  'timeout',
  'unavailable',
  'fetch_empty',
  'failed',
] as const;

export type WebResearchIssue = (typeof researchIssues)[number];

export interface WebResearchSource {
  title: string;
  url: string;
  kind: 'search' | 'page';
}

export interface WebResearch {
  version: 1;
  provider: 'Exa';
  searches: number;
  cachedSearches: number;
  emptySearches: number;
  pagesRead: number;
  issues: WebResearchIssue[];
  sources: WebResearchSource[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9999;

function publicSourceUrl(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^https?:\/\//i.test(value) ||
    /[\s\p{Cc}\\]/u.test(value)
  )
    return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const host = url.hostname.replace(/\.$/, '');
  const labels = host.split('.');
  if (
    url.username ||
    url.password ||
    labels.length < 2 ||
    !/[a-z]/.test(labels.at(-1) || '') ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /\.(?:localhost|local|internal|test|invalid|onion|lan|home|arpa)$/.test(host)
  )
    return;
  url.hash = '';
  return url.href.length <= 2048 ? url.href : undefined;
}

function parseSource(value: unknown): WebResearchSource | undefined {
  if (
    !isObject(value) ||
    (value.kind !== 'search' && value.kind !== 'page') ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 240 ||
    /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value.title)
  )
    return;
  const url = publicSourceUrl(value.url);
  if (url) return { title: value.title, url, kind: value.kind };
}

export function parseWebResearchMessage(message: Message): WebResearch | undefined {
  if (message.kind !== 'web_research' || message.role !== 'assistant' || message.status !== 'done')
    return;
  const record = message.metadata?.webResearch;
  if (!isObject(record)) return;
  const { version, provider, searches, cachedSearches, emptySearches, pagesRead, issues, sources } =
    record;
  if (
    version !== 1 ||
    provider !== 'Exa' ||
    !count(searches) ||
    !count(cachedSearches) ||
    !count(emptySearches) ||
    !count(pagesRead) ||
    emptySearches > searches ||
    !Array.isArray(issues) ||
    !Array.isArray(sources)
  )
    return;
  const publicSources = new Map<string, WebResearchSource>();
  for (const row of sources.slice(0, 12)) {
    const source = parseSource(row);
    if (!source) continue;
    const previous = publicSources.get(source.url);
    if (!previous || (previous.kind === 'search' && source.kind === 'page'))
      publicSources.set(source.url, source);
  }
  return {
    version,
    provider,
    searches,
    cachedSearches,
    emptySearches,
    pagesRead,
    issues: researchIssues.filter((issue) => issues.includes(issue)),
    sources: Array.from(publicSources.values()),
  };
}
