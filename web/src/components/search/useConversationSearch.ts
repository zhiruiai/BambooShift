import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import '../ConversationSearch.css';
import {
  CommandEntry,
  ConversationSearchProps,
  SearchEntry,
  SearchCategory,
  RECENT_RESULTS_LIMIT,
  createIndex,
  findMatches,
  normalize,
  termsFor,
} from './parts';
import { messageLinks } from '../../messageLinks';
import { websiteProjectFor } from '../../websiteProjects';
const PAGE_SIZE = 48;

export function useConversationSearch({
  data,
  currentConversationId,
  initialScope = 'all',
  onClose,
  onJump,
  onOpenFile,
  onOpenRoutine,
  onOpenWebsite,
  commands = [],
}: ConversationSearchProps) {
  const [scope, setScope] = useState<'all' | 'current'>(initialScope);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SearchCategory>('all');
  const [expandedLimit, setExpandedLimit] = useState<number>();
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const listId = useId();
  const deferredQuery = useDeferredValue(query);
  const searching = query !== deferredQuery;
  const files = !!onOpenFile;
  const routines = !!onOpenRoutine;
  const websites = !!onOpenWebsite;
  const index = useMemo(
    () => createIndex(data, { files, routines, websites }),
    [
      data.agents,
      data.conversations,
      data.messages,
      data.files,
      data.routines,
      files,
      routines,
      websites,
    ],
  );
  const results = useMemo(
    () => findMatches(index, deferredQuery, scope, currentConversationId, category),
    [index, deferredQuery, scope, currentConversationId, category],
  );
  const terms = useMemo(() => termsFor(deferredQuery), [deferredQuery]);
  const commandEntries: CommandEntry[] =
    scope === 'all' && category === 'all'
      ? commands
          .filter((command) =>
            terms.every((term) =>
              normalize(
                `${command.title} ${command.description} ${command.keywords || ''}`,
              ).includes(term),
            ),
          )
          .map((command) => ({ ...command, kind: 'command' }))
      : [];
  const hasQuery = !!normalize(deferredQuery);
  const initialLimit = !hasQuery && category === 'all' ? RECENT_RESULTS_LIMIT : PAGE_SIZE;
  const visibleLimit = expandedLimit ?? initialLimit;
  const entries: Array<SearchEntry | CommandEntry> = [
    ...commandEntries,
    ...results.entries.slice(0, visibleLimit),
  ];
  const resultCount = results.entries.length + commandEntries.length;
  const hasMore = entries.length < resultCount;
  const selected = Math.min(activeIndex, Math.max(0, entries.length - 1));
  const latest = useRef({
    commands,
    onClose,
    onJump,
    onOpenFile,
    onOpenRoutine,
    onOpenWebsite,
    data,
  });
  latest.current = { commands, onClose, onJump, onOpenFile, onOpenRoutine, onOpenWebsite, data };
  const active = useRef(true);
  const currentExists = data.conversations.some(
    (conversation) => conversation.id === currentConversationId,
  );
  useEffect(() => {
    active.current = true;
    inputRef.current?.focus();
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    optionRefs.current[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected, results.entries, commandEntries.length, visibleLimit]);

  const openResult = (entry: SearchEntry | CommandEntry) => {
    if (searching || !active.current) return;
    const current = latest.current;
    const conversation =
      'conversationId' in entry && entry.conversationId
        ? current.data.conversations.find((item) => item.id === entry.conversationId)
        : undefined;
    if ('conversationId' in entry && entry.conversationId && !conversation) return;
    if (entry.kind === 'command') {
      const command = current.commands.find((item) => item.id === entry.id);
      if (!command) return;
      active.current = false;
      current.onClose();
      command.run();
    } else if (entry.kind === 'file') {
      const file = current.data.files.find(
        (item) => item.id === entry.id && item.conversationId === entry.conversationId,
      );
      if (!file || !current.onOpenFile) return;
      active.current = false;
      current.onOpenFile(file);
    } else if (entry.kind === 'routine') {
      const routine = current.data.routines.find(
        (item) => item.id === entry.id && item.conversationId === entry.conversationId,
      );
      if (!routine || !conversation?.agentIds.includes(routine.agentId) || !current.onOpenRoutine)
        return;
      active.current = false;
      current.onOpenRoutine(routine);
    } else if (entry.kind === 'link' || entry.kind === 'website') {
      const message = current.data.messages.find(
        (item) => item.id === entry.messageId && item.conversationId === entry.conversationId,
      );
      if (!message) return;
      if (entry.kind === 'website') {
        if (websiteProjectFor(message)?.id !== entry.versionId || !current.onOpenWebsite) return;
        active.current = false;
        current.onOpenWebsite(message);
      } else if (messageLinks(message).some((link) => link.href === entry.href)) {
        active.current = false;
        current.onJump(entry.conversationId, entry.messageId);
        current.onClose();
      }
    } else {
      if (
        entry.kind === 'message' &&
        !current.data.messages.some(
          (message) =>
            message.id === entry.messageId && message.conversationId === entry.conversationId,
        )
      )
        return;
      active.current = false;
      current.onJump(entry.conversationId, entry.kind === 'message' ? entry.messageId : undefined);
      current.onClose();
    }
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target as HTMLElement;
    if (target !== inputRef.current && target.getAttribute('role') !== 'option') return;
    if (!entries.length || searching) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next =
        (selected + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      setActiveIndex(next);
      if (target !== inputRef.current) optionRefs.current[next]?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openResult(entries[selected]);
    }
  };
  const resetPosition = () => {
    setActiveIndex(0);
    setExpandedLimit(undefined);
  };
  const changeQuery = (next: string) => {
    setQuery(next);
    resetPosition();
  };
  const changeScope = (next: 'all' | 'current') => {
    setScope(next);
    resetPosition();
    inputRef.current?.focus();
  };
  const changeCategory = (next: SearchCategory) => {
    setCategory(next);
    resetPosition();
  };
  const showMore = () => {
    if (searching || !hasMore) return;
    setExpandedLimit(visibleLimit + PAGE_SIZE);
    setActiveIndex(entries.length);
    inputRef.current?.focus();
  };
  const categories: SearchCategory[] = ['all', 'message', 'bot', 'group'];
  if (files) categories.push('file');
  if (routines) categories.push('routine');
  if (websites) categories.push('website');
  categories.push('link');

  return {
    commands,
    onClose,
    keyboard,
    inputRef,
    query,
    entries,
    listId,
    selected,
    changeQuery,
    setActiveIndex,
    scope,
    changeScope,
    currentExists,
    searching,
    hasQuery,
    commandEntries,
    categories,
    category,
    changeCategory,
    resultCount,
    hasMore,
    showMore,
    optionRefs,
    openResult,
    terms,
  };
}
