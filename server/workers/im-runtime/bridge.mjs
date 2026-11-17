import { eventKey, routeKey } from './protocol.mjs';

export function createBridge({
  config,
  ledger,
  dispatch,
  reply,
  authorize,
  signal,
  report = () => {},
}) {
  const bindings = new Map();
  for (const account of config.accounts)
    for (const binding of account.bindings)
      bindings.set(routeKey({ ...binding, accountId: account.id }), {
        ...binding,
        provider: account.provider,
      });
  const queues = new Map(),
    pending = new Set();
  function accept(event) {
    if (!event || signal.aborted) return false;
    const binding = bindings.get(routeKey(event));
    if (
      !binding ||
      binding.provider !== event.provider ||
      (event.group && (!binding.allowGroup || !event.mentioned))
    )
      return false;
    const route = routeKey(event),
      key = eventKey(event);
    const queue = queues.get(route) || { count: 0, tail: Promise.resolve() };
    if (queue.count >= 4 || pending.size >= 32) {
      report({ accountId: event.accountId, status: 'capacity-reached' });
      return false;
    }
    if (!ledger.claim(key)) return false;
    queue.count++;
    queues.set(route, queue);
    const task = queue.tail.then(async () => {
      try {
        signal.throwIfAborted();
        await authorize(binding, signal);
        const content = await dispatch(binding, event.text, 'im-' + key, signal);
        signal.throwIfAborted();
        // Recheck the current actor/session before releasing any model output externally.
        await authorize(binding, signal);
        await reply(event, content, signal);
        ledger.finish(key, 'delivered');
        report({ accountId: event.accountId, status: 'delivered' });
      } catch {
        // Neither an unknown model submission nor an unknown send is automatically retried.
        try {
          ledger.finish(key, signal.aborted ? 'cancelled' : 'unknown');
        } catch {
          // Keep the pending key if durable status cannot be updated.
        }
        report({ accountId: event.accountId, status: signal.aborted ? 'cancelled' : 'unknown' });
      } finally {
        queue.count--;
        if (!queue.count) queues.delete(route);
      }
    });
    queue.tail = task.catch(() => {});
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return true;
  }
  return {
    accept,
    drain: async () => {
      await Promise.allSettled([...pending]);
    },
  };
}
