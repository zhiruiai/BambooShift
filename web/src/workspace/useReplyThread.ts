import { useEffect, useMemo, useState } from 'react';
import type { Bootstrap, Message } from '../../../shared/types';

export function useReplyThread(data: Bootstrap | null, selected: string, scope: string) {
  const [active, setActive] = useState<{ conversationId: string; rootId: string; scope: string }>();
  function setOpenThread(conversationId: string, rootId?: string) {
    setActive(rootId ? { conversationId, rootId, scope } : undefined);
  }
  const all = useMemo(
    () => data?.messages.filter((message) => message.conversationId === selected) || [],
    [data?.messages, selected],
  );
  const root =
    active?.conversationId === selected && active.scope === scope
      ? all.find((message) => message.id === active.rootId && !message.threadRootId)
      : undefined;
  useEffect(() => {
    if (active && !root) setActive(undefined);
  }, [active, root]);

  const replies = useMemo(() => {
    const counts = new Map<string, number>();
    for (const message of all) {
      if (
        !message.threadRootId ||
        message.role === 'system' ||
        message.kind === 'activity' ||
        message.kind === 'web_research'
      )
        continue;
      if (message.status === 'running' && !message.content.trim()) continue;
      counts.set(message.threadRootId, (counts.get(message.threadRootId) || 0) + 1);
    }
    return counts;
  }, [all]);
  const messages = useMemo(
    () =>
      root
        ? [root, ...all.filter((message) => message.threadRootId === root.id)]
        : all.filter((message) => !message.threadRootId),
    [all, root],
  );
  return { all, root, messages, replies, setOpenThread };
}

export function threadWorking(
  active: boolean,
  conversationId: string,
  messages: Message[],
  requests: Bootstrap['runningRequests'],
  rootId?: string,
) {
  if (!active) return false;
  const runs = requests?.filter((run) => run.conversationId === conversationId);
  if (runs?.length) return runs.some((run) => run.threadRootId === rootId);
  const candidates = messages.filter(
    (message) => message.status === 'running' || message.delivery?.state === 'queued',
  );
  return candidates.length
    ? candidates.some((message) => message.threadRootId === rootId)
    : !rootId;
}
