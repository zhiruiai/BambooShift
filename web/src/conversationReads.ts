import type { Conversation } from '../../shared/types';

export function createConversationReads(options: {
  current: () => boolean;
  visible: () => boolean;
  conversation: () => Conversation | undefined;
  acknowledge: (id: string, readThrough: number) => Promise<unknown>;
  changed: () => void;
}) {
  const confirmed = new Map<string, number>();
  const attempted = new Map<string, number>();
  let busy = false,
    stopped = false;
  async function scan(retry = false) {
    if (stopped || busy || !options.current() || !options.visible()) return;
    const chat = options.conversation(),
      through = chat?.readThrough;
    if (
      !chat ||
      !Number.isSafeInteger(through) ||
      through! < 0 ||
      chat.unread <= 0 ||
      through! <= (confirmed.get(chat.id) ?? -1) ||
      (!retry && through! <= (attempted.get(chat.id) ?? -1))
    )
      return;
    busy = true;
    attempted.set(chat.id, through!);
    try {
      await options.acknowledge(chat.id, through!);
      if (stopped || !options.current()) return;
      confirmed.set(chat.id, through!);
      options.changed();
    } catch {
      // A read acknowledgement is monotonic. A later explicit focus or scroll
      // can retry this same observed watermark without consuming a newer delivery.
    } finally {
      busy = false;
      // A different visible conversation may have arrived while this ACK was pending.
      // Attempt suppression prevents an unknown same-watermark submission loop.
      void scan();
    }
  }
  return {
    scan,
    stop() {
      stopped = true;
    },
  };
}
