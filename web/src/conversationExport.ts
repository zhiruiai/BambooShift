import { conversationExport, type ConversationExport } from '../../shared/conversation-export';

type ExportScope = {
  request<T>(path: string, method?: string): Promise<T>;
  ticket(): number;
  current(ticket: number): boolean;
  suspend(): void;
};

export function createConversationExport(scope: ExportScope, id: string, current: () => boolean) {
  const ticket = scope.ticket();
  let closed = false;
  const guard = () => {
    if (closed || !current() || !scope.current(ticket))
      throw new DOMException('Cancelled', 'AbortError');
  };
  const path = `/conversations/${encodeURIComponent(id)}/export`;
  return {
    async load(language: 'en' | 'zh-CN') {
      guard();
      const value = await scope.request<unknown>(`${path}?language=${language}`);
      guard();
      return conversationExport(value, id);
    },
    async deliver(
      value: ConversationExport,
      consume: (data: ConversationExport) => void | Promise<void>,
    ) {
      guard();
      conversationExport(value, id);
      await scope.request(path, 'HEAD');
      guard();
      await consume(value);
      guard();
    },
    close() {
      closed = true;
      scope.suspend();
    },
  };
}
