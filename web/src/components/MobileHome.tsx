import { uiText } from '../i18n';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Loader2, Plus, RefreshCw, Search, Settings, WifiOff, Zap } from 'lucide-react';
import type { BotAgent, Conversation } from '../../../shared/types';
import type { SidebarRosterState } from '../../../shared/sidebar-roster';
import { isConversationHidden, rosterConversationOrder } from '../sidebarRoster';
import { Avatar } from './Avatar';
import './MobileHome.css';

export function useMobileHome() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width:760px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width:760px)');
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}

export function MobileHomeHeader({
  accountMenu,
  online,
  connectionLabel,
  onRetry,
  canCreateBot = true,
  onSettings,
  onApps,
  onSearch,
  onCreate,
  createLabel,
}: {
  accountMenu?: ReactNode;
  online: boolean;
  connectionLabel?: string;
  onRetry: () => Promise<unknown>;
  canCreateBot?: boolean;
  onSettings: () => void;
  onApps: () => void;
  onSearch: () => void;
  onCreate: () => void;
  createLabel?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const menuRoot = useRef<HTMLDivElement>(null);
  const avatarButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menuRoot.current?.contains(event.target))
        setMenuOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    const frame = requestAnimationFrame(() =>
      menuRoot.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(),
    );
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      cancelAnimationFrame(frame);
    };
  }, [menuOpen]);
  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!menuOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenuOpen(false);
      avatarButton.current?.focus();
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from(
        menuRoot.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [],
      );
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }
  function choose(action: () => void) {
    avatarButton.current?.focus();
    setMenuOpen(false);
    action();
  }
  return (
    <>
      <header className="mobile-home-header" aria-label={uiText('common:text_056c999fb13a')}>
        {accountMenu || (
          <div className="mobile-workspace-menu-wrap" ref={menuRoot} onKeyDown={menuKey}>
            <button
              ref={avatarButton}
              type="button"
              className="mobile-profile-trigger"
              aria-label={uiText('common:text_92bc6028e975')}
              title={uiText('common:text_e30e9ba009e8')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? 'mobile-workspace-menu' : undefined}
              onClick={() => setMenuOpen((value) => !value)}
            >
              <span className="user-avatar" aria-hidden="true">
                H
              </span>
              <span
                className={`mobile-profile-status ${online ? '' : 'offline'}`}
                aria-hidden="true"
              />
            </button>
            {menuOpen && (
              <div
                className="mobile-workspace-menu"
                id="mobile-workspace-menu"
                role="menu"
                aria-label={uiText('common:text_e30e9ba009e8')}
              >
                <div className="mobile-workspace-menu-heading">
                  <strong>{uiText('common:text_e30e9ba009e8')}</strong>
                  <small>
                    {online
                      ? uiText('common:text_8d3e69d58cfc')
                      : uiText('common:text_360f969c99aa')}
                  </small>
                </div>
                <button type="button" role="menuitem" onClick={() => choose(onSettings)}>
                  <Settings size={16} />
                  <span>{uiText('common:text_c27d63b467b6')}</span>
                </button>
                <button type="button" role="menuitem" onClick={() => choose(onApps)}>
                  <Zap size={16} />
                  <span>{uiText('common:text_b1bea2878095')}</span>
                </button>
              </div>
            )}
          </div>
        )}
        <div className="mobile-home-actions">
          <button
            type="button"
            aria-label={uiText('common:text_db352a3a740b')}
            title={uiText('common:text_44ce7ae909bb')}
            onClick={onSearch}
          >
            <Search size={19} />
          </button>
          <button
            type="button"
            aria-label={
              createLabel ||
              (canCreateBot
                ? uiText('common:text_beb08ccef5c0')
                : uiText('common:text_675ee6eef7be'))
            }
            title={
              createLabel ||
              (canCreateBot
                ? uiText('common:text_beb08ccef5c0')
                : uiText('common:text_675ee6eef7be'))
            }
            onClick={onCreate}
          >
            <Plus size={22} />
          </button>
        </div>
      </header>
      {(!online || connectionLabel) && (
        <div className="mobile-connection-banner" role="status">
          {online ? (
            <RefreshCw size={16} aria-hidden="true" />
          ) : (
            <WifiOff size={16} aria-hidden="true" />
          )}
          <span>
            {connectionLabel || uiText('common:text_ee5304101fa5')}
            <small>{retryError || uiText('common:text_2c80d240083d')}</small>
          </span>
          <button
            type="button"
            disabled={retrying}
            onClick={async () => {
              if (retrying) return;
              setRetrying(true);
              setRetryError('');
              try {
                await onRetry();
              } catch (error) {
                setRetryError(
                  error instanceof Error ? error.message : uiText('common:text_090e02c30569'),
                );
              } finally {
                setRetrying(false);
              }
            }}
          >
            {retrying ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {retrying ? uiText('common:text_3af7e5489e61') : uiText('common:text_b8784c8dd563')}
          </button>
        </div>
      )}
    </>
  );
}

export function MobileBotShortcuts({
  agents,
  conversations,
  selectedId,
  primaryConversationId,
  sidebarRoster,
  isWorking,
  onOpen,
}: {
  agents: BotAgent[];
  conversations: Conversation[];
  selectedId: string;
  primaryConversationId?: string;
  sidebarRoster?: SidebarRosterState;
  isWorking: (conversationId: string) => boolean;
  onOpen: (conversation: Conversation) => void;
}) {
  const items = useMemo(() => {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const seen = new Set<string>();
    const result: { agent: BotAgent; conversation: Conversation }[] = [];
    const ordered = conversations
      .filter(
        (conversation) =>
          !conversation.isGroup &&
          conversation.agentIds.length === 1 &&
          !isConversationHidden(conversation, sidebarRoster),
      )
      .slice()
      .sort((left, right) =>
        rosterConversationOrder(left, right, sidebarRoster, primaryConversationId),
      );
    for (const conversation of ordered) {
      const agent = byId.get(conversation.agentIds[0]);
      if (!agent || seen.has(agent.id)) continue;
      seen.add(agent.id);
      result.push({ agent, conversation });
      if (result.length === 6) break;
    }
    return result;
  }, [agents, conversations, primaryConversationId, sidebarRoster]);
  if (!items.length) return null;
  return (
    <nav className="mobile-bot-shortcuts" aria-label={uiText('common:text_31be3b2335c7')}>
      {items.map(({ agent, conversation }) => (
        <button
          key={agent.id}
          type="button"
          className={`mobile-bot-shortcut ${selectedId === conversation.id ? 'selected' : ''}`}
          aria-label={uiText('common:text_8df7f040c002', {
            value0: agent.name,
            value1: isWorking(conversation.id) ? uiText('common:text_2fd8d12c39f8') : '',
          })}
          title={`${agent.name} · ${agent.role}`}
          onClick={() => onOpen(conversation)}
        >
          <span className="mobile-bot-portrait">
            <Avatar agent={agent} size={52} />
            {isWorking(conversation.id) && (
              <span className="mobile-bot-working" aria-hidden="true" />
            )}
          </span>
          <span className="mobile-bot-name">{agent.name}</span>
        </button>
      ))}
    </nav>
  );
}
