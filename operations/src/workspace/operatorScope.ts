import { platformApi } from '../../../web/src/platform/platformApi';

/** Bind operator requests to the identity that opened this view. */
export function createOperatorScope(userId: string | undefined) {
  let active = true;
  let epoch = 0;
  const pending = new Set<AbortController>();
  const current = (ticket: number) => active && epoch === ticket;
  return {
    activate() {
      active = true;
    },
    suspend() {
      active = false;
      epoch++;
      for (const controller of pending) controller.abort();
      pending.clear();
    },
    async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      const ticket = epoch;
      if (!userId || !current(ticket) || !/^\/platform\//.test(path))
        throw new DOMException('Operator view is no longer active.', 'AbortError');
      const controller = new AbortController();
      pending.add(controller);
      try {
        const result = await platformApi<T>(path, method, body, {
          expectedUser: userId,
          signal: controller.signal,
        });
        if (!current(ticket)) throw new DOMException('Operator view changed.', 'AbortError');
        return result;
      } finally {
        pending.delete(controller);
      }
    },
  };
}
