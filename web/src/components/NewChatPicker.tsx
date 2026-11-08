import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, Bot, EyeOff, Search, Sparkles, Users, X } from 'lucide-react';
import type { Conversation } from '../../../shared/types';
import { uiText } from '../i18n';
import { newChatChoices, type NewChatSnapshot } from '../newChatPicker';
import { Avatar, GroupAvatar } from './Avatar';
import './NewChatPicker.css';

export interface NewChatPickerProps {
  data: NewChatSnapshot;
  canCreateBot: boolean;
  isCurrent: () => boolean;
  onOpen: (conversation: Conversation) => void;
  onCreate: (mode: 'bot' | 'group' | 'team') => void;
  onClose: () => void;
}

export function NewChatPicker(props: NewChatPickerProps) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState<string>();
  const latest = useRef(props);
  latest.current = props;
  const active = useRef(true);
  const composing = useRef(false);
  const restoreFocus = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const choices = newChatChoices(props.data, query);
  const selected = choices.find((choice) => choice.conversation.id === highlighted) || choices[0];
  const selectedIndex = choices.indexOf(selected);
  const current = () => active.current && latest.current.isCurrent();
  function close() {
    if (!current()) return;
    active.current = false;
    latest.current.onClose();
  }
  function open(id: string) {
    if (!current()) return;
    const choice = newChatChoices(latest.current.data).find((item) => item.conversation.id === id);
    if (!choice) return;
    active.current = false;
    restoreFocus.current = false;
    latest.current.onClose();
    latest.current.onOpen(choice.conversation);
  }
  function create(mode: 'bot' | 'group' | 'team') {
    if (!current() || (mode !== 'group' && !latest.current.canCreateBot)) return;
    active.current = false;
    restoreFocus.current = false;
    latest.current.onClose();
    latest.current.onCreate(mode);
  }
  useEffect(() => {
    active.current = true;
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (!current() || composing.current || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (event.key === 'Tab') {
        const nodes = [
          ...(panel.current?.querySelectorAll<HTMLElement>('input,button:not([disabled])') || []),
        ].filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0);
        const first = nodes[0],
          last = nodes.at(-1);
        if (
          !nodes.includes(document.activeElement as HTMLElement) ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      active.current = false;
      document.removeEventListener('keydown', keydown);
      if (restoreFocus.current && latest.current.isCurrent() && previous?.isConnected)
        previous.focus();
    };
  }, []);
  useEffect(() => {
    panel.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selected?.conversation.id]);
  function searchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (!current() || composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
      return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (choices.length) {
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        setHighlighted(
          choices[(selectedIndex + offset + choices.length) % choices.length].conversation.id,
        );
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (selected) open(selected.conversation.id);
    }
  }
  if (!props.isCurrent()) return null;
  return (
    <div
      className="new-chat-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="new-chat-picker"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-chat-title"
      >
        <header>
          <h2 id="new-chat-title">{uiText('workspace:newChatTitle')}</h2>
          <button
            type="button"
            className="new-chat-close"
            aria-label={uiText('workspace:newChatClose')}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <label className="new-chat-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={input}
            value={query}
            role="combobox"
            aria-label={uiText('workspace:newChatSearch')}
            aria-controls="new-chat-results"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={selected ? `new-chat-result-${selectedIndex}` : undefined}
            placeholder={uiText('workspace:newChatSearch')}
            autoComplete="off"
            onKeyDown={searchKey}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlighted(undefined);
            }}
          />
        </label>
        <p className="new-chat-section-title">{uiText('workspace:newChatExisting')}</p>
        <div
          id="new-chat-results"
          className="new-chat-results"
          role="listbox"
          aria-label={uiText('workspace:newChatExisting')}
        >
          {choices.map((choice, index) => (
            <button
              type="button"
              role="option"
              tabIndex={-1}
              id={`new-chat-result-${index}`}
              key={choice.conversation.id}
              aria-selected={choice === selected}
              className="new-chat-choice"
              onClick={() => open(choice.conversation.id)}
            >
              {choice.conversation.isGroup ? (
                <GroupAvatar agents={choice.agents} size={34} />
              ) : (
                <Avatar agent={choice.agents[0]} size={34} animate={false} />
              )}
              <span className="new-chat-choice-copy">
                <strong>{choice.title}</strong>
                <span>{choice.detail}</span>
              </span>
              {choice.hidden && (
                <span className="new-chat-hidden" title={uiText('workspace:newChatHiddenHint')}>
                  <EyeOff size={14} />
                  <span>{uiText('workspace:newChatHidden')}</span>
                </span>
              )}
              <ArrowUpRight size={15} className="new-chat-open-icon" aria-hidden="true" />
            </button>
          ))}
        </div>
        {!choices.length && (
          <p className="new-chat-empty" role="status">
            {uiText(query.trim() ? 'workspace:newChatNoMatch' : 'workspace:newChatEmpty')}
          </p>
        )}
        <div className="new-chat-actions">
          {props.canCreateBot && (
            <button type="button" onClick={() => create('bot')}>
              <Bot size={18} />
              <span>{uiText('workspace:newChatCreateBot')}</span>
            </button>
          )}
          <button type="button" onClick={() => create('group')}>
            <Users size={18} />
            <span>{uiText('workspace:newChatCreateGroup')}</span>
          </button>
          {props.canCreateBot && (
            <button type="button" onClick={() => create('team')}>
              <Sparkles size={18} />
              <span>{uiText('workspace:newChatPlanTeam')}</span>
            </button>
          )}
        </div>
        <p className="new-chat-hint">{uiText('workspace:newChatKeyboardHint')}</p>
      </div>
    </div>
  );
}
