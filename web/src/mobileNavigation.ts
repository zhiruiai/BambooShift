export type MobilePage = { view: 'home' | 'chat' | 'details'; conversationId?: string };

const field = 'openbotMobileNavigation';
type Entry = MobilePage & { scope: string; session: string; depth: 0 | 1 | 2 };
type BrowserHistory = Pick<History, 'state' | 'pushState' | 'replaceState' | 'go'>;

/** Own only same-document mobile entries; never change a workspace URL or other history state. */
export function createMobileNavigation({
  history,
  scope,
  isCurrentScope,
  onChange,
}: {
  history: BrowserHistory;
  scope: string;
  isCurrentScope: () => boolean;
  onChange: (page: MobilePage) => void;
}) {
  const session = globalThis.crypto.randomUUID();
  let enabled = false;
  let waiting = false;
  let afterBack: MobilePage | undefined;
  const entries = new Map<number, Entry>();

  function current(): Entry | undefined {
    const entry = history.state?.[field] as Entry | undefined;
    return entry?.scope === scope && entry.session === session && entries.has(entry.depth)
      ? entry
      : undefined;
  }
  function write(page: MobilePage, depth: Entry['depth'], push = false) {
    const entry: Entry = { ...page, depth, scope, session };
    const previous = history.state;
    const state = {
      ...(previous && typeof previous === 'object' ? previous : {}),
      [field]: entry,
    };
    // Omitting the URL intentionally preserves deep-link parameters and hash fragments.
    if (push) history.pushState(state, '');
    else history.replaceState(state, '');
    entries.set(depth, entry);
    return entry;
  }
  function move(page: MobilePage): boolean {
    if (!enabled || !isCurrentScope()) return false;
    if (waiting) {
      afterBack = page;
      return true;
    }
    let entry = current();
    if (!entry) entry = write({ view: 'home' }, 0);
    const depth = page.view === 'home' ? 0 : page.view === 'chat' ? 1 : 2;
    if (depth < entry.depth) {
      // Only entries created by this controller may be traversed programmatically.
      if (entries.has(depth)) {
        waiting = true;
        afterBack = page;
        history.go(depth - entry.depth);
        return true;
      }
    }
    if (depth === 2 && entry.depth === 0) {
      entry = write({ view: 'chat', conversationId: page.conversationId }, 1, true);
    }
    if (depth > entry.depth) {
      for (const key of entries.keys()) if (key > entry.depth) entries.delete(key);
    }
    write(page, depth, depth > entry.depth);
    onChange(page);
    return true;
  }
  return {
    activate(page: MobilePage) {
      enabled = true;
      move(page);
    },
    deactivate() {
      enabled = false;
      afterBack = undefined;
    },
    move,
    pop() {
      waiting = false;
      if (!enabled || !isCurrentScope()) {
        afterBack = undefined;
        return;
      }
      const entry = current();
      const page = afterBack;
      afterBack = undefined;
      if (!entry) {
        // A foreign/previous workspace entry is not a reason to add another history entry.
        onChange({ view: 'home' });
        return;
      }
      if (page) move(page);
      else onChange(entry);
    },
  };
}
