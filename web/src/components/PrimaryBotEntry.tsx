import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Settings, UserRound, ArrowRight } from 'lucide-react';
import type { BotAgent, Conversation } from '../../../shared/types';
import type { PrimaryBotState, PrimaryCheckInStatus } from '../../../shared/primary-bot';
import type { PrimaryBotMode } from './PrimaryBotDialog';
import { Avatar } from './Avatar';
import './PrimaryBot.css';
import { displayTimeZone, validTimeZone } from '../timeZones';

export function primaryBotSummary(
  state: PrimaryBotState,
  conversation?: Conversation,
  working = false,
  status?: PrimaryCheckInStatus,
) {
  if (!state.available) return uiText('bots:text_495286efc927');
  if (!state.agentId) return uiText('bots:text_8e6979b47f1d');
  if (!conversation) return uiText('bots:text_ad89970fd63c');
  if (working) return uiText('bots:text_1967f541db92');
  if (!state.checkIn.enabled) return uiText('bots:text_2f53e0c143b8');
  if (status?.status === 'no_model') return uiText('bots:text_a45c7525c4ba');
  if (status?.status === 'running') return uiText('bots:text_0379afa5ab76');
  if (status?.status === 'error' || status?.status === 'interrupted')
    return uiText('bots:text_01b9bc79caeb');
  if (!validTimeZone(state.checkIn.timeZone ?? 'Asia/Shanghai'))
    return uiText('bots:text_f5852a05df1f');
  return uiText('bots:text_a5687127dd45', {
    value0: state.checkIn.time,
    value1: displayTimeZone(state.checkIn.timeZone),
  });
}

export function PrimaryBotIntroduction({
  onManage,
}: {
  onManage: (mode?: PrimaryBotMode) => void;
}) {
  return (
    <div className="empty-conversation primary-bot-intro">
      <Avatar size={76} />
      <h2>{uiText('bots:text_c8ee9f3ea8fe')}</h2>
      <p>{uiText('bots:text_d7a4dd52742d')}</p>
      <div className="primary-intro-actions">
        <button type="button" className="primary-button" onClick={() => onManage('create')}>
          {uiText('bots:text_8d3f686b13bb')}
        </button>
        <button type="button" className="secondary-button" onClick={() => onManage('select')}>
          {uiText('bots:text_a7406d22ea9e')}
        </button>
      </div>
    </div>
  );
}
export function PrimaryBotEntry({
  state,
  agent,
  conversation,
  selected,
  working,
  checkInStatus,
  onOpen,
  onManage,
}: {
  state?: PrimaryBotState;
  agent?: BotAgent;
  conversation?: Conversation;
  selected: boolean;
  working: boolean;
  checkInStatus?: PrimaryCheckInStatus;
  onOpen: (conversation: Conversation) => void;
  onManage: (mode?: PrimaryBotMode) => void;
}) {
  const [open, setOpen] = useState(false),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);
  if (!state) return null;
  const manage = (mode?: PrimaryBotMode) => {
    setOpen(false);
    onManage(mode);
  };
  return (
    <div
      className="primary-bot-entry"
      ref={root}
      onContextMenu={(event) => {
        if (!state.available || !agent) return;
        event.preventDefault();
        setOpen(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const items = Array.from(
            root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [],
          );
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
    >
      <button
        type="button"
        className={`conversation-row primary-bot-row ${selected ? 'selected' : ''}`}
        onClick={() => (conversation ? onOpen(conversation) : manage())}
        aria-label={
          conversation && agent
            ? uiText('bots:text_3f04dc33f481', { value0: agent.name })
            : state.available
              ? uiText('bots:text_f0eb23a5cf1b')
              : uiText('bots:text_8dde04a30690')
        }
      >
        <span className="conversation-avatar">
          <Avatar agent={agent} size={40} />
          {working && <span className="status-dot working" />}
        </span>
        <span className="conversation-copy">
          <span className="conversation-heading">
            <span>{agent?.name || uiText('bots:text_1671a317eae2')}</span>
            <small className="primary-bot-badge">
              {state.available
                ? uiText('bots:text_33bc0375810d')
                : uiText('bots:text_51fcaa8035fc')}
            </small>
          </span>
          <span className="conversation-preview">
            {primaryBotSummary(state, conversation, working, checkInStatus)}
          </span>
        </span>
        {conversation?.unread ? <span className="unread-badge">{conversation.unread}</span> : null}
      </button>
      {state.available && agent && (
        <>
          <button
            type="button"
            className="primary-bot-menu-button icon-button"
            aria-label={uiText('bots:text_dcdad438b23b')}
            aria-haspopup="menu"
            aria-expanded={open}
            ref={trigger}
            onClick={() => setOpen((value) => !value)}
          >
            <MoreHorizontal size={18} />
          </button>
          {open && (
            <div
              className="dropdown-menu primary-bot-menu"
              role="menu"
              aria-label={uiText('bots:text_128b59ec6366')}
            >
              <button type="button" role="menuitem" onClick={() => manage('select')}>
                <UserRound size={15} />
                {uiText('bots:text_40d48b2e7c30')}
              </button>
              <button type="button" role="menuitem" onClick={() => manage('select')}>
                <Settings size={15} />
                {uiText('bots:text_921cde352bfd')}
              </button>
              {conversation && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onOpen(conversation);
                  }}
                >
                  <ArrowRight size={15} />
                  {uiText('bots:text_90bc67d355fc')}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
