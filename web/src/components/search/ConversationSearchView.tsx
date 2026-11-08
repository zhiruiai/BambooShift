import { uiText, type UiTextKey } from '../../i18n';
import {
  ArrowUpRight,
  Clock3,
  CornerDownLeft,
  FileText,
  Globe2,
  Link2,
  MessageCircle,
  Plus,
  Search,
  Users,
  X,
} from 'lucide-react';
import '../ConversationSearch.css';
import { Dialog } from '../UI';
import { Highlight, dateLabel, excerpt, type SearchCategory } from './parts';
import type { useConversationSearch } from './useConversationSearch';
const categoryLabels: Record<SearchCategory, UiTextKey> = {
  all: 'common:searchCategoryAll',
  message: 'common:searchCategoryMessages',
  bot: 'common:searchCategoryBots',
  group: 'common:searchCategoryGroups',
  file: 'common:searchCategoryFiles',
  routine: 'common:searchCategoryRoutines',
  website: 'common:searchCategoryWebsites',
  link: 'common:searchCategoryLinks',
};

export type ConversationSearchModel = ReturnType<typeof useConversationSearch>;
function resultIcon(entry: ConversationSearchModel['entries'][number]) {
  switch (entry.kind) {
    case 'command':
      return Plus;
    case 'file':
      return FileText;
    case 'routine':
      return Clock3;
    case 'link':
      return Link2;
    case 'website':
      return Globe2;
    case 'conversation':
      return entry.isGroup ? Users : MessageCircle;
    case 'message':
      return MessageCircle;
  }
}

export function ConversationSearchView(model: ConversationSearchModel) {
  const {
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
  } = model;
  const summary = searching
    ? uiText('common:text_1986994f3057')
    : hasMore
      ? uiText('common:searchResultProgress', { shown: entries.length, total: resultCount })
      : hasQuery || category !== 'all'
        ? uiText('common:searchResultCount', { count: resultCount })
        : scope === 'current'
          ? uiText('common:text_9800a458c16b')
          : commandEntries.length
            ? uiText('common:text_bbe5723e1a2b')
            : uiText('common:text_807883eff57f');
  return (
    <Dialog
      scrollBody={false}
      title={
        commands.length ? uiText('common:text_1ddc08e4ea3f') : uiText('common:text_2fa31f0786c5')
      }
      onClose={onClose}
      className="conversation-search"
    >
      <div className="history-search-content" onKeyDown={keyboard}>
        <div className="history-search-field">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            maxLength={160}
            type="search"
            autoComplete="off"
            spellCheck={false}
            aria-label={
              commands.length
                ? uiText('common:text_69850614f1e1')
                : uiText('common:text_bcf22c057074')
            }
            placeholder={
              commands.length
                ? uiText('common:searchWorkspacePlaceholder')
                : uiText('common:text_98a1e44844a6')
            }
            role="combobox"
            aria-expanded={entries.length > 0}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={entries.length ? `${listId}-${selected}` : undefined}
            onChange={(event) => changeQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="history-search-clear"
              aria-label={uiText('common:text_b6f00afa6537')}
              onClick={() => {
                changeQuery('');
                inputRef.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className="history-search-filters">
          <div
            className="history-search-scope"
            role="group"
            aria-label={uiText('common:text_4e65d015121f')}
          >
            <button type="button" aria-pressed={scope === 'all'} onClick={() => changeScope('all')}>
              {uiText('common:text_19c6c208f94e')}
            </button>
            <button
              type="button"
              aria-pressed={scope === 'current'}
              disabled={!currentExists}
              onClick={() => changeScope('current')}
            >
              {uiText('common:text_9800a458c16b')}
            </button>
          </div>
          <div
            className="history-search-categories"
            role="group"
            aria-label={uiText('common:searchCategoryLabel')}
          >
            {categories.map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={category === value}
                onClick={() => changeCategory(value)}
              >
                {uiText(categoryLabels[value])}
              </button>
            ))}
          </div>
          <select
            className="history-search-scope-select"
            aria-label={uiText('common:text_4e65d015121f')}
            value={scope}
            onChange={(event) => changeScope(event.target.value === 'current' ? 'current' : 'all')}
          >
            <option value="all">{uiText('common:searchScopeWorkspace')}</option>
            <option value="current" disabled={!currentExists}>
              {uiText('common:searchScopeChat')}
            </option>
          </select>
          <select
            className="history-search-category-select"
            aria-label={uiText('common:searchCategoryLabel')}
            value={category}
            onChange={(event) => {
              const next = categories.find((value) => value === event.target.value);
              if (next) changeCategory(next);
            }}
          >
            {categories.map((value) => (
              <option key={value} value={value}>
                {uiText(categoryLabels[value])}
              </option>
            ))}
          </select>
        </div>
        <div className="history-search-summary" aria-live="polite" role="status">
          {summary}
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label={uiText('common:text_88d72ece7cf7')}
          aria-busy={searching}
          className="history-search-results"
        >
          {entries.map((entry, position) => {
            const Icon = resultIcon(entry);
            return (
              <div
                key={`${entry.kind}:${entry.id}`}
                id={`${listId}-${position}`}
                role="option"
                aria-selected={position === selected}
                tabIndex={position === selected ? 0 : -1}
                ref={(node) => {
                  optionRefs.current[position] = node;
                }}
                className={`history-search-result ${position === selected ? 'is-selected' : ''}`}
                onFocus={() => setActiveIndex(position)}
                onMouseEnter={() => setActiveIndex(position)}
                onClick={() => openResult(entry)}
              >
                <span className={`history-search-result-icon ${entry.kind}`} aria-hidden="true">
                  <Icon size={17} />
                </span>
                <div className="history-search-result-copy">
                  <div className="history-search-result-top">
                    <strong>
                      <Highlight text={entry.title} terms={terms} />
                    </strong>
                    {entry.kind === 'command' ? (
                      entry.shortcut && (
                        <kbd className="history-search-shortcut">{entry.shortcut}</kbd>
                      )
                    ) : entry.createdAt ? (
                      <time
                        dateTime={
                          Number.isFinite(Date.parse(entry.createdAt)) ? entry.createdAt : undefined
                        }
                      >
                        {dateLabel(entry.createdAt)}
                      </time>
                    ) : null}
                  </div>
                  {entry.kind === 'message' && (
                    <div className="history-search-author">
                      <Highlight text={entry.author} terms={terms} />
                      {entry.removedAuthor && <span>{uiText('common:text_174688c755b9')}</span>}
                    </div>
                  )}
                  <p>
                    <Highlight
                      text={
                        entry.kind === 'command' ? entry.description : excerpt(entry.content, terms)
                      }
                      terms={terms}
                    />
                  </p>
                  {entry.kind === 'conversation' && (
                    <span className="history-search-kind">
                      {uiText(
                        entry.isGroup ? 'common:searchGroupResult' : 'common:searchBotResult',
                      )}
                    </span>
                  )}
                  {entry.kind === 'command' && (
                    <span className="history-search-kind">
                      {uiText('common:text_899432d83d98')}
                    </span>
                  )}
                  {entry.kind === 'file' && (
                    <span className="history-search-kind">{uiText('common:searchFile')}</span>
                  )}
                  {entry.kind === 'routine' && (
                    <span className="history-search-kind">{uiText('common:searchRoutine')}</span>
                  )}
                  {entry.kind === 'link' && (
                    <span className="history-search-kind">{uiText('common:searchLink')}</span>
                  )}
                  {entry.kind === 'website' && (
                    <span className="history-search-kind">{uiText('common:searchWebsite')}</span>
                  )}
                </div>
                <ArrowUpRight className="history-search-open" size={15} aria-hidden="true" />
              </div>
            );
          })}
        </div>
        {!entries.length && !searching && (
          <div className="history-search-empty">
            <Search size={30} strokeWidth={1.3} aria-hidden="true" />
            <strong>
              {hasQuery || category !== 'all'
                ? uiText('common:text_a1942ad6063a')
                : uiText('common:text_c29cc445a967')}
            </strong>
            <p>
              {hasQuery
                ? uiText('common:text_2e7bcbe9ecc6')
                : category !== 'all'
                  ? uiText('common:searchCategoryEmpty')
                  : uiText('common:text_fecb1014f949')}
            </p>
            {(hasQuery || category !== 'all') && scope === 'current' && (
              <button type="button" onClick={() => changeScope('all')}>
                {uiText('common:text_cf16d672d6dc')}
                <ArrowUpRight size={13} />
              </button>
            )}
          </div>
        )}
        {hasMore && (
          <div className="history-search-more">
            <button type="button" disabled={searching} onClick={showMore} aria-controls={listId}>
              {uiText('common:searchShowMore')}
            </button>
          </div>
        )}
        <footer className="history-search-footer">
          <span>{uiText('common:text_a0bc6f22ab94')}</span>
          <span className="history-search-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            {uiText('common:text_106ac341420a')}{' '}
            <kbd>
              <CornerDownLeft size={11} />
            </kbd>{' '}
            {uiText('common:text_84041df0ce44')}
            <kbd>esc</kbd>
            {uiText('common:text_92c4b180a403')}
          </span>
        </footer>
      </div>
    </Dialog>
  );
}
