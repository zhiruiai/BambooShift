import { currentLanguage, uiText } from '../../i18n';
import { type ReactNode } from 'react';
import type { Bootstrap, Message, Routine, WorkspaceFile } from '../../../../shared/types';
import { fileSize } from '../../fileFormatting';
import { websiteProjectFor } from '../../websiteProjects';
import { messageLinks } from '../../messageLinks';
import '../ConversationSearch.css';
export interface ConversationSearchProps {
  data: Bootstrap;
  currentConversationId: string;
  initialScope?: 'all' | 'current';
  onClose: () => void;
  onJump: (conversationId: string, messageId?: string) => void;
  onOpenFile?: (file: WorkspaceFile) => void;
  onOpenRoutine?: (routine: Routine) => void;
  onOpenWebsite?: (message: Message) => void;
  commands?: SearchCommand[];
}
export interface SearchCommand {
  id: string;
  title: string;
  description: string;
  keywords?: string;
  shortcut?: string;
  run: () => void;
}
export type CommandEntry = SearchCommand & { kind: 'command' };
interface SearchResult {
  id: string;
  title: string;
  content: string;
  createdAt?: string;
  timestamp: number;
  searchText: string;
}
export type SearchEntry = SearchResult &
  (
    | { kind: 'conversation'; conversationId: string; isGroup: boolean }
    | {
        kind: 'message';
        conversationId: string;
        messageId: string;
        author: string;
        removedAuthor: boolean;
      }
    | { kind: 'file'; conversationId?: string }
    | { kind: 'routine'; conversationId: string }
    | { kind: 'link'; conversationId: string; messageId: string; href: string }
    | { kind: 'website'; conversationId: string; messageId: string; versionId: string }
  );
export type SearchCategory =
  'all' | 'message' | 'bot' | 'group' | 'file' | 'routine' | 'website' | 'link';
export interface SearchIndex {
  conversations: SearchEntry[];
  messages: SearchEntry[];
  files: SearchEntry[];
  routines: SearchEntry[];
  links: SearchEntry[];
  websites: SearchEntry[];
}
export interface ConversationSearchResults {
  entries: SearchEntry[];
  conversationCount: number;
  messageCount: number;
  fileCount: number;
  routineCount: number;
  linkCount: number;
  websiteCount: number;
  truncated: boolean;
}
const RESULT_LIMIT = 60;
export const RECENT_RESULTS_LIMIT = 8;
export const normalize = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
export const termsFor = (query: string) => [
  ...new Set(normalize(query).split(' ').filter(Boolean)),
];
export const timestamp = (value: string) =>
  Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
export function authorFor(message: Message, agents: Bootstrap['agents']) {
  if (message.role === 'user') {
    const author = message.metadata?.author as { name?: unknown } | undefined;
    return {
      name: typeof author?.name === 'string' ? author.name : uiText('common:text_a0c7716669b5'),
      removed: false,
    };
  }
  if (message.role === 'system')
    return { name: uiText('common:text_5b50d7c4b595'), removed: false };
  const snapshot = message.metadata?.author;
  const snapshotId =
    snapshot &&
    typeof snapshot === 'object' &&
    !Array.isArray(snapshot) &&
    'id' in snapshot &&
    typeof snapshot.id === 'string'
      ? snapshot.id
      : undefined;
  const authorId = message.agentId || snapshotId;
  const current = agents.find((agent) => agent.id === authorId);
  if (current) return { name: current.name, removed: false };
  const historicalName =
    snapshot &&
    typeof snapshot === 'object' &&
    !Array.isArray(snapshot) &&
    'name' in snapshot &&
    typeof snapshot.name === 'string'
      ? snapshot.name.trim()
      : '';
  // An absent/deleted author must never inherit another current member's identity.
  return {
    name: historicalName || (authorId ? uiText('common:text_0583e9855b7b') : 'Bot'),
    removed: !!authorId,
  };
}
export function createIndex(
  data: Bootstrap,
  include = { files: true, routines: true, websites: true },
): SearchIndex {
  const conversations = new Map(
    data.conversations.map((conversation) => [conversation.id, conversation]),
  );
  const newestFirst = (a: SearchEntry, b: SearchEntry) =>
    b.timestamp - a.timestamp || a.id.localeCompare(b.id);
  const visibleMessages = data.messages.filter((message) =>
    conversations.has(message.conversationId),
  );
  return {
    conversations: data.conversations
      .map((conversation) => {
        const members = conversation.agentIds.map(
          (id) =>
            data.agents.find((agent) => agent.id === id)?.name ||
            uiText('common:text_0583e9855b7b'),
        );
        const content = members.length
          ? uiText('common:text_c3b94139ac77', {
              value0: members.join(uiText('common:punct_c4a40ea8fe35')),
            })
          : uiText('common:text_2da0b2a8111d');
        return {
          id: `conversation:${conversation.id}`,
          kind: 'conversation' as const,
          conversationId: conversation.id,
          title: conversation.title,
          content,
          createdAt: conversation.updatedAt,
          timestamp: timestamp(conversation.updatedAt),
          isGroup: conversation.isGroup,
          searchText: normalize(`${conversation.title} ${members.join(' ')}`),
        };
      })
      .sort(newestFirst),
    messages: visibleMessages
      .map((message) => {
        const conversation = conversations.get(message.conversationId)!;
        const author = authorFor(message, data.agents);
        return {
          id: `message:${message.id}`,
          kind: 'message' as const,
          conversationId: message.conversationId,
          messageId: message.id,
          title: conversation.title,
          author: author.name,
          removedAuthor: author.removed,
          content: message.content,
          createdAt: message.createdAt,
          timestamp: timestamp(message.createdAt),
          searchText: normalize(`${author.name} ${message.content}`),
        };
      })
      .sort(newestFirst),
    links: visibleMessages
      .flatMap((message): SearchEntry[] =>
        messageLinks(message).map(({ label, href }, position) => ({
          id: `${message.id}:${position}`,
          kind: 'link',
          conversationId: message.conversationId,
          messageId: message.id,
          href,
          title: label,
          content: `${href} · ${conversations.get(message.conversationId)!.title}`,
          createdAt: message.createdAt,
          timestamp: timestamp(message.createdAt),
          searchText: normalize(`${label} ${href}`),
        })),
      )
      .sort(newestFirst),
    websites: (include.websites ? visibleMessages : [])
      .flatMap((message): SearchEntry[] => {
        const project = websiteProjectFor(message);
        if (!project || message.status === 'running' || message.status === 'error') return [];
        const conversation = conversations.get(message.conversationId)!;
        return [
          {
            id: message.id,
            kind: 'website',
            conversationId: message.conversationId,
            messageId: message.id,
            versionId: project.id,
            title: project.title,
            content: `${conversation.title} · ${project.entry}`,
            createdAt: message.createdAt,
            timestamp: timestamp(message.createdAt),
            searchText: normalize(`${project.title} ${project.entry}`),
          },
        ];
      })
      .sort(newestFirst),
    files: (include.files ? data.files : [])
      .filter((file) => !file.conversationId || conversations.has(file.conversationId))
      .map((file): SearchEntry => ({
        id: file.id,
        kind: 'file',
        conversationId: file.conversationId,
        title: file.name,
        content:
          (file.conversationId && conversations.get(file.conversationId)?.title) ||
          fileSize(file.size),
        createdAt: file.createdAt,
        timestamp: timestamp(file.createdAt),
        searchText: normalize(file.name),
      }))
      .sort(newestFirst),
    routines: (include.routines ? data.routines : [])
      .filter((routine) =>
        conversations.get(routine.conversationId)?.agentIds.includes(routine.agentId),
      )
      .map((routine): SearchEntry => ({
        id: routine.id,
        kind: 'routine',
        conversationId: routine.conversationId,
        title: routine.title,
        content: conversations.get(routine.conversationId)!.title,
        createdAt: routine.lastRunAt,
        timestamp: timestamp(routine.lastRunAt || ''),
        searchText: normalize(routine.title),
      }))
      .sort(newestFirst),
  };
}
export function findMatches(
  index: SearchIndex,
  query: string,
  scope: 'all' | 'current',
  currentConversationId: string,
  category: SearchCategory,
): Omit<ConversationSearchResults, 'truncated'> {
  const terms = termsFor(query);
  const inScope = (entry: SearchEntry) =>
    scope === 'all' || entry.conversationId === currentConversationId;
  const matches = (entry: SearchEntry) =>
    inScope(entry) && terms.every((term) => entry.searchText.includes(term));
  const all = category === 'all';
  const recent = all && !terms.length;
  const conversations =
    all || category === 'bot' || category === 'group'
      ? index.conversations.filter(
          (entry) =>
            matches(entry) &&
            entry.kind === 'conversation' &&
            (all || entry.isGroup === (category === 'group')),
        )
      : [];
  const matching = (kind: SearchCategory, entries: SearchEntry[]) =>
    (!recent && all) || category === kind ? entries.filter(matches) : [];
  const messages = matching('message', index.messages);
  const files = matching('file', index.files);
  const routines = matching('routine', index.routines);
  const links = matching('link', index.links);
  const websites = matching('website', index.websites);
  // Represent each result type early, then retain all remaining matches for progressive reveal.
  const entries = [
    ...conversations.slice(0, 8),
    ...files.slice(0, 8),
    ...routines.slice(0, 8),
    ...websites.slice(0, 6),
    ...links.slice(0, 6),
    ...messages.slice(0, 12),
    ...files.slice(8),
    ...routines.slice(8),
    ...websites.slice(6),
    ...links.slice(6),
    ...messages.slice(12),
    ...conversations.slice(8),
  ];
  return {
    entries,
    conversationCount: conversations.length,
    messageCount: messages.length,
    fileCount: files.length,
    routineCount: routines.length,
    linkCount: links.length,
    websiteCount: websites.length,
  };
}
export function searchConversationHistory(
  data: Bootstrap,
  query: string,
  scope: 'all' | 'current',
  currentConversationId: string,
): ConversationSearchResults {
  const result = findMatches(createIndex(data), query, scope, currentConversationId, 'all');
  const limit = normalize(query) ? RESULT_LIMIT : RECENT_RESULTS_LIMIT;
  return {
    ...result,
    entries: result.entries.slice(0, limit),
    truncated: result.entries.length > limit,
  };
}
export function excerpt(text: string, terms: string[], length = 180) {
  const plain = text.replace(/\s+/g, ' ').trim();
  if (!plain) return uiText('common:text_8c2dbde6ede5');
  const lower = plain.toLocaleLowerCase();
  const hits = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const first = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, first - 42);
  return `${start ? '…' : ''}${plain.slice(start, start + length)}${start + length < plain.length ? '…' : ''}`;
}
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const lower = text.toLocaleLowerCase(),
    pieces: ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const next = terms
      .map((term) => ({ term, index: lower.indexOf(term, cursor) }))
      .filter((hit) => hit.index >= 0)
      .sort((a, b) => a.index - b.index || b.term.length - a.term.length)[0];
    if (!next) {
      pieces.push(text.slice(cursor));
      break;
    }
    if (next.index > cursor) pieces.push(text.slice(cursor, next.index));
    pieces.push(
      <mark key={`${next.index}:${next.term}`}>
        {text.slice(next.index, next.index + next.term.length)}
      </mark>,
    );
    cursor = next.index + next.term.length;
  }
  return <>{pieces}</>;
}
export function dateLabel(date: string) {
  if (!Number.isFinite(Date.parse(date))) return uiText('common:text_0a680746ce36');
  return new Intl.DateTimeFormat(currentLanguage(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(date));
}
