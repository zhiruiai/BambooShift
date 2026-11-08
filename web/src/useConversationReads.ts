import { useEffect, useRef } from 'react';
import type { Conversation } from '../../shared/types';
import { createConversationReads } from './conversationReads';

export function conversationViewportVisible(node: HTMLElement | null) {
  if (
    !node ||
    document.hidden ||
    !document.hasFocus() ||
    !node.isConnected ||
    node.getClientRects().length === 0 ||
    node.clientHeight <= 0
  )
    return false;
  const rect = node.getBoundingClientRect();
  return (
    rect.right > rect.left &&
    rect.bottom > rect.top &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth &&
    node.scrollHeight - node.scrollTop - node.clientHeight < 100
  );
}
export function useConversationReads(options: {
  conversation?: Conversation;
  viewport: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  current: () => boolean;
  acknowledge: (id: string, readThrough: number) => Promise<unknown>;
  changed: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<ReturnType<typeof createConversationReads> | null>(null);
  useEffect(() => {
    const reads = createConversationReads({
      current: () => latest.current.current(),
      visible: () =>
        latest.current.enabled && conversationViewportVisible(latest.current.viewport.current),
      conversation: () => latest.current.conversation,
      acknowledge: (id, through) => latest.current.acknowledge(id, through),
      changed: () => latest.current.changed(),
    });
    controller.current = reads;
    void reads.scan();
    return () => {
      reads.stop();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    const scan = () => {
      void controller.current?.scan(true);
    };
    window.addEventListener('focus', scan);
    document.addEventListener('visibilitychange', scan);
    window.addEventListener('resize', scan);
    const viewport = latest.current.viewport.current;
    viewport?.addEventListener('scroll', scan);
    const observer =
      typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(scan);
    if (viewport) observer?.observe(viewport);
    void controller.current?.scan();
    return () => {
      window.removeEventListener('focus', scan);
      document.removeEventListener('visibilitychange', scan);
      window.removeEventListener('resize', scan);
      viewport?.removeEventListener('scroll', scan);
      observer?.disconnect();
    };
  }, [options.viewport.current]);
  useEffect(() => {
    void controller.current?.scan();
  }, [
    options.enabled,
    options.conversation?.id,
    options.conversation?.readThrough,
    options.conversation?.unread,
  ]);
}
