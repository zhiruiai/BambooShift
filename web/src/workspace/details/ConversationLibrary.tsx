import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pin } from 'lucide-react';
import { libraryItemKey, type LibraryItem, type LibraryPin } from '../../conversationLibrary';
import { timestamp } from '../../dates';
import { uiText } from '../../i18n';
import './ConversationLibrary.css';

const filters = {
  all: 'workspace:libraryAll',
  pinned: 'workspace:libraryPinned',
  website: 'workspace:libraryWebsites',
  file: 'workspace:libraryFiles',
  media: 'workspace:libraryMedia',
  link: 'workspace:libraryLinksFilter',
} as const;
type LibraryFilter = keyof typeof filters;

const groups = {
  pinned: 'workspace:libraryPinned',
  today: 'workspace:libraryToday',
  week: 'workspace:libraryWeek',
  older: 'workspace:libraryOlder',
} as const;
type LibraryGroup = keyof typeof groups;
const PAGE_SIZE = 5;

function groupItems(items: LibraryItem[], pins: LibraryPin[], filter: LibraryFilter) {
  const pinTimes = new Map(pins.map((pin) => [libraryItemKey(pin), timestamp(pin.pinnedAt)]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const entries: Record<LibraryGroup, Array<{ item: LibraryItem; time: number }>> = {
    pinned: [],
    today: [],
    week: [],
    older: [],
  };
  for (const item of items) {
    if (filter === 'media' && !item.media) continue;
    if (filter === 'file' && item.media) continue;
    if (filter !== 'all' && filter !== 'pinned' && filter !== 'media' && filter !== item.kind)
      continue;
    const pinnedAt = pinTimes.get(libraryItemKey(item));
    if (pinnedAt !== undefined) {
      entries.pinned.push({ item, time: pinnedAt });
    } else if (filter !== 'pinned') {
      const time = timestamp(item.createdAt);
      const group = time >= today.getTime() ? 'today' : time >= week.getTime() ? 'week' : 'older';
      entries[group].push({ item, time });
    }
  }
  return (Object.keys(groups) as LibraryGroup[]).flatMap((group) =>
    entries[group].length
      ? [{ group, rows: entries[group].sort((first, second) => second.time - first.time) }]
      : [],
  );
}

export function ConversationLibrary({
  items,
  pins,
  pinState,
  saving,
  onPin,
  onRetry,
  renderItem,
  fileTools,
}: {
  items: LibraryItem[];
  pins: LibraryPin[];
  pinState: 'loading' | 'ready' | 'error';
  saving?: string;
  onPin: (item: LibraryItem, pinned: boolean) => void;
  onRetry: () => void;
  renderItem: (item: LibraryItem) => ReactNode;
  fileTools?: ReactNode;
}) {
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [limits, setLimits] = useState<Partial<Record<LibraryGroup, number>>>({});
  const entries = useMemo(() => groupItems(items, pins, filter), [items, pins, filter]);
  const container = useRef<HTMLDivElement>(null);
  const pinFocus = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (saving || !pinFocus.current) return;
    const id = pinFocus.current;
    pinFocus.current = null;
    if (document.activeElement !== document.body || !container.current) return;
    // Pinning can move a row between lists; unpinning can remove it from this filter.
    const button = Array.from(
      container.current.querySelectorAll<HTMLButtonElement>('.conversation-library-pin'),
    ).find((candidate) => candidate.dataset.libraryItem === id && !candidate.disabled);
    (
      button ?? container.current.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
    )?.focus();
  }, [entries, saving]);

  return (
    <div className="conversation-library" ref={container}>
      <div
        className="conversation-library-filters"
        role="group"
        aria-label={uiText('workspace:libraryFilterLabel')}
      >
        {(Object.keys(filters) as LibraryFilter[]).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={name === filter}
            onClick={() => {
              if (name !== filter) setLimits({});
              setFilter(name);
            }}
          >
            {uiText(filters[name])}
          </button>
        ))}
      </div>
      {(filter === 'all' || filter === 'file') && fileTools}
      {pinState === 'error' && (
        <div className="conversation-library-notice conversation-library-pin-error">
          <span role="alert">{uiText('workspace:libraryPinReadFailed')}</span>
          <button type="button" className="text-button" onClick={onRetry}>
            {uiText('workspace:libraryPinRetry')}
          </button>
        </div>
      )}
      {filter === 'pinned' && pinState === 'loading' && (
        <p className="conversation-library-notice" role="status">
          {uiText('workspace:libraryPinLoading')}
        </p>
      )}
      {!entries.length && (filter !== 'pinned' || pinState === 'ready') && (
        <p className="conversation-library-notice">
          {uiText(
            filter === 'all'
              ? 'workspace:libraryEmpty'
              : filter === 'pinned'
                ? 'workspace:libraryPinnedEmpty'
                : 'workspace:libraryFilterEmpty',
          )}
        </p>
      )}
      {entries.map(({ group, rows }) => {
        const limit = limits[group] ?? PAGE_SIZE;
        const pinned = group === 'pinned';
        return (
          <section className="conversation-library-group" key={group}>
            {filter !== 'pinned' && <h3>{uiText(groups[group])}</h3>}
            <ul role="list">
              {rows.slice(0, limit).map(({ item }) => {
                const id = libraryItemKey(item);
                const label = uiText(pinned ? 'workspace:libraryUnpin' : 'workspace:libraryPin', {
                  title: item.title,
                });
                return (
                  <li className="conversation-library-row" key={id}>
                    <div className="conversation-library-row-content">{renderItem(item)}</div>
                    <button
                      className="conversation-library-pin"
                      type="button"
                      data-library-item={id}
                      data-pinned={pinned}
                      aria-label={label}
                      title={label}
                      aria-busy={saving === id || undefined}
                      aria-disabled={saving === id || undefined}
                      disabled={pinState !== 'ready' || (!!saving && saving !== id)}
                      onClick={(event) => {
                        if (saving) return;
                        if (document.activeElement === event.currentTarget) pinFocus.current = id;
                        onPin(item, !pinned);
                      }}
                    >
                      <Pin size={15} fill={pinned ? 'currentColor' : 'none'} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {rows.length > limit && (
              <button
                type="button"
                className="text-button conversation-library-more"
                onClick={() => setLimits({ ...limits, [group]: limit + PAGE_SIZE })}
              >
                {uiText('workspace:libraryShowMore')}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
