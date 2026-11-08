import { uiText } from '../i18n';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  LogOut,
  Plus,
  Settings,
  UserRound,
  Users,
  Zap,
} from 'lucide-react';
import type { AccountSession, WorkspaceSummary } from '../../../shared/platform';
import { TeamCreateDialog } from './account/TeamCreateDialog';
import { platformApi, workspacePath } from './platformApi';
import './Platform.css';

import { AccountInitial } from './account/AccountInitial';
export { AccountInitial } from './account/AccountInitial';
export function WorkspaceChooser({
  session,
  onSessionChange,
}: {
  session: AccountSession;
  onSessionChange?: (session: AccountSession) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!session.authenticated)
    return (
      <p className="platform-help">
        {uiText('account:text_85f601121b42')}
        <a href="/login">{uiText('account:text_d9a999a7c8e8')}</a>
        {uiText('common:punct_eb0d5884569b')}
      </p>
    );
  return (
    <section className="account-workspace-chooser" aria-label={uiText('account:text_135488633bd6')}>
      <div className="account-person">
        <AccountInitial name={session.user?.name} />
        <div>
          <strong>{session.user?.name}</strong>
          <small>{session.user?.email}</small>
        </div>
      </div>
      <div className="account-space-list">
        {session.workspaces.length ? (
          session.workspaces.map((workspace) => (
            <a
              key={workspace.id}
              href={workspace.status === 'active' ? workspacePath(workspace.id) : undefined}
              className={`account-space-row ${workspace.status === 'suspended' ? 'is-disabled' : ''}`}
              aria-disabled={workspace.status === 'suspended'}
            >
              {workspace.kind === 'team' ? <Users size={20} /> : <UserRound size={20} />}
              <span>
                <strong>{workspace.name}</strong>
                <small>
                  {workspace.kind === 'team'
                    ? uiText('account:text_2714df648cbd')
                    : uiText('account:text_51fcaa8035fc')}{' '}
                  ·{' '}
                  {workspace.status === 'suspended'
                    ? uiText('account:text_a8c3698b5b8c')
                    : workspace.role === 'owner'
                      ? uiText('account:text_3a3912b23eeb')
                      : uiText('account:text_6e6d6ddbb7c1')}
                </small>
              </span>
              {workspace.status === 'active' && <ArrowRight size={16} />}
            </a>
          ))
        ) : (
          <p className="platform-empty">{uiText('account:text_5a717b1898f3')}</p>
        )}
      </div>
      {error && (
        <p className="platform-error" role="alert">
          {error}
        </p>
      )}
      <div className="account-chooser-actions">
        <a className="secondary-button" href="/account">
          <UserRound size={15} />
          {uiText('account:text_5ce662ac8d87')}
        </a>
        <button className="secondary-button" type="button" onClick={() => setCreating(true)}>
          <Plus size={15} />
          {uiText('account:text_d2ec1c315266')}
        </button>
        <button
          className="platform-text-button"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await platformApi('/account/logout', 'POST');
              onSessionChange?.({ authenticated: false, workspaces: [] });
              window.location.assign('/login');
            } catch (cause) {
              setError((cause as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <LogOut size={14} />
          {uiText('account:text_e76774368ccf')}
        </button>
      </div>
      {creating && (
        <TeamCreateDialog
          onClose={() => setCreating(false)}
          onCreated={(workspace) => window.location.assign(workspacePath(workspace.id))}
        />
      )}
    </section>
  );
}

export function AccountMenu({
  session,
  activeWorkspaceId,
  onSessionChange,
  onSettings,
  onApps,
  navigationDisabled = false,
}: {
  session: AccountSession;
  activeWorkspaceId?: string;
  onSessionChange?: (session: AccountSession) => void;
  onSettings?: () => void;
  onApps?: () => void;
  navigationDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed', left: 12, top: 12 });
  const active = session.workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  useLayoutEffect(() => {
    if (!open || navigationDisabled) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        setOpen(false);
        return;
      }
      const width = Math.min(280, window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 19;
      const above = rect.top - 19;
      const upward = below < 250 && above > below;
      setPosition({
        position: 'fixed',
        width,
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        top: upward ? undefined : Math.max(12, rect.bottom + 7),
        bottom: upward ? Math.max(12, window.innerHeight - rect.top + 7) : undefined,
        maxHeight: Math.max(80, Math.min(540, upward ? above : below)),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, navigationDisabled]);
  useEffect(() => {
    if (!open || navigationDisabled) return;
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    const frame = requestAnimationFrame(() =>
      panel.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
        ?.focus(),
    );
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open, navigationDisabled]);
  useEffect(() => {
    if (navigationDisabled) setOpen(false);
  }, [navigationDisabled]);
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
        ) || [],
      );
      const current = items.indexOf(document.activeElement as HTMLElement);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[index]?.focus();
    }
  }
  if (!session.authenticated)
    return (
      <a className="secondary-button" href="/login">
        {uiText('account:text_d9a999a7c8e8')}
      </a>
    );
  return (
    <div className="account-menu" ref={root} onKeyDown={key}>
      <button
        ref={trigger}
        type="button"
        className="account-menu-trigger"
        aria-label={uiText('account:text_28501a155fe8')}
        aria-haspopup="menu"
        aria-expanded={open && !navigationDisabled}
        disabled={navigationDisabled}
        onClick={() => setOpen((value) => !value)}
      >
        <AccountInitial name={session.user?.name} />
        <span>
          <strong>
            {active?.name || session.user?.name || uiText('account:text_aff95a53b063')}
          </strong>
          <small>
            {active?.kind === 'team'
              ? uiText('account:text_2714df648cbd')
              : uiText('account:text_51fcaa8035fc')}
          </small>
        </span>
        <ChevronDown size={15} />
      </button>
      {open &&
        !navigationDisabled &&
        createPortal(
          <div
            ref={panel}
            style={position}
            className="account-menu-panel"
            role="menu"
            aria-label={uiText('account:text_70f527ddc222')}
          >
            <div className="account-menu-heading">
              <strong>{session.user?.name}</strong>
              <small>{session.user?.email}</small>
            </div>
            <a className="account-menu-item" role="menuitem" href="/account">
              <UserRound size={16} />
              <span>{uiText('account:text_5ce662ac8d87')}</span>
            </a>
            <div className="account-menu-spaces">
              {session.workspaces.map((workspace) => (
                <a
                  key={workspace.id}
                  role="menuitem"
                  className="account-menu-item"
                  href={workspace.status === 'active' ? workspacePath(workspace.id) : undefined}
                  aria-disabled={workspace.status === 'suspended'}
                  tabIndex={workspace.status === 'suspended' ? -1 : undefined}
                >
                  {workspace.kind === 'team' ? <Users size={16} /> : <UserRound size={16} />}
                  <span>
                    {workspace.name}
                    {workspace.status === 'suspended' && (
                      <small>{uiText('account:text_a8c3698b5b8c')}</small>
                    )}
                  </span>
                  {workspace.id === activeWorkspaceId && <Check size={14} />}
                </a>
              ))}
            </div>
            {active?.status === 'active' && active.kind === 'team' && (
              <a
                className="account-menu-item"
                role="menuitem"
                href={`${workspacePath(active.id)}/members`}
              >
                <Users size={16} />
                <span>{uiText('account:text_2e6bfec616ad')}</span>
              </a>
            )}
            {active?.status === 'active' &&
              active.kind === 'personal' &&
              active.role === 'owner' && (
                <a
                  className="account-menu-item"
                  role="menuitem"
                  href={`${workspacePath(active.id)}/members`}
                >
                  <BookOpen size={16} />
                  <span>{uiText('account:text_4e6f8d64ac11')}</span>
                </a>
              )}
            {active?.status === 'active' && active.role === 'owner' && (
              <a
                className="account-menu-item"
                role="menuitem"
                href={`${workspacePath(active.id)}/manage`}
              >
                <Settings size={16} />
                <span>{uiText('account:text_c6bdf6d83d2c')}</span>
              </a>
            )}
            {onSettings && (
              <button
                className="account-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  trigger.current?.focus();
                  setOpen(false);
                  onSettings();
                }}
              >
                <Settings size={16} />
                <span>
                  {active?.role === 'member'
                    ? uiText('account:text_11345eb54c09')
                    : uiText('account:text_c27d63b467b6')}
                </span>
              </button>
            )}
            {onApps && (
              <button
                className="account-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  trigger.current?.focus();
                  setOpen(false);
                  onApps();
                }}
              >
                <Zap size={16} />
                <span>{uiText('account:text_b1bea2878095')}</span>
              </button>
            )}
            <button
              className="account-menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                trigger.current?.focus();
                setOpen(false);
                setCreating(true);
              }}
            >
              <Plus size={16} />
              <span>{uiText('account:text_4ce7ada52267')}</span>
            </button>
            {error && (
              <p className="platform-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="account-menu-item"
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await platformApi('/account/logout', 'POST');
                  onSessionChange?.({ authenticated: false, workspaces: [] });
                  window.location.assign('/login');
                } catch (cause) {
                  setError((cause as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <LogOut size={16} />
              <span>
                {busy ? uiText('account:text_0ae60dd37b14') : uiText('account:text_e76774368ccf')}
              </span>
            </button>
          </div>,
          document.body,
        )}
      {creating && (
        <TeamCreateDialog
          onClose={() => setCreating(false)}
          onCreated={(workspace) => window.location.assign(workspacePath(workspace.id))}
        />
      )}
    </div>
  );
}
