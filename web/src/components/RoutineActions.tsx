import { ArrowRightLeft, MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { uiText } from '../i18n';
import './RoutineActions.css';

type Props = {
  title: string;
  enabled: boolean;
  canManage?: boolean;
  disabled?: boolean;
  deleteDisabled?: boolean;
  className?: string;
  children: ReactNode;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTransfer?: () => void;
};

export function RoutineActions(props: Props) {
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const mounted = useRef(true);
  latest.current = props;
  const allowed = () =>
    mounted.current && latest.current.canManage !== false && !latest.current.disabled;
  function close(restoreFocus = false) {
    setPosition(undefined);
    if (restoreFocus) trigger.current?.focus();
  }
  function show(x?: number, y?: number) {
    if (!allowed()) return;
    const rect = trigger.current?.getBoundingClientRect();
    const width = Math.min(224, Math.max(120, window.innerWidth - 16));
    setPosition({
      left: Math.max(
        8,
        Math.min(x ?? (rect?.right || width + 8) - width, window.innerWidth - width - 8),
      ),
      top: Math.max(
        8,
        Math.min(
          y ?? (rect?.bottom || 8) + 4,
          window.innerHeight - (latest.current.onTransfer ? 200 : 156),
        ),
      ),
    });
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (props.disabled || props.canManage === false) close();
  }, [props.disabled, props.canManage]);
  useEffect(() => {
    if (!position) return;
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !menu.current?.contains(event.target)
      )
        close();
    };
    const dismiss = (event: Event) => {
      if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [position]);
  function perform(kind: 'onToggle' | 'onEdit' | 'onDelete' | 'onTransfer') {
    if (!allowed() || (kind === 'onDelete' && latest.current.deleteDisabled)) return;
    close(true);
    latest.current[kind]?.();
  }
  const label = uiText('workspace:detailRoutineMenu', { title: props.title });
  return (
    <div
      className={`routine-action-host ${props.className || ''}`}
      ref={root}
      onContextMenu={(event) => {
        if (!allowed()) return;
        event.preventDefault();
        show(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          if (!allowed()) return;
          event.preventDefault();
          event.stopPropagation();
          show();
        }
      }}
    >
      {props.children}
      {props.canManage !== false && (
        <button
          ref={trigger}
          type="button"
          className="icon-button routine-more"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={!!position}
          disabled={props.disabled}
          onClick={() => (position ? close() : show())}
        >
          <MoreHorizontal size={17} />
        </button>
      )}
      {position &&
        props.canManage !== false &&
        !props.disabled &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            className="dropdown-menu routine-action-menu"
            aria-label={label}
            style={{ position: 'fixed', ...position }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              } else if (event.key === 'Tab') {
                close(true);
              } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const items = Array.from(
                  menu.current?.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]:not(:disabled)',
                  ) || [],
                );
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                        items.length;
                items[next]?.focus();
              }
            }}
          >
            <button type="button" role="menuitem" onClick={() => perform('onToggle')}>
              {props.enabled ? <Pause size={16} /> : <Play size={16} />}
              {uiText(
                props.enabled ? 'workspace:detailPauseRoutine' : 'workspace:detailResumeRoutine',
              )}
            </button>
            <button type="button" role="menuitem" onClick={() => perform('onEdit')}>
              <Pencil size={16} />
              {uiText('workspace:detailEditRoutine')}
            </button>
            {props.onTransfer && (
              <button type="button" role="menuitem" onClick={() => perform('onTransfer')}>
                <ArrowRightLeft size={16} />
                {uiText('workspace:routineTransferTitle')}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="routine-menu-delete"
              disabled={props.deleteDisabled}
              onClick={() => perform('onDelete')}
            >
              <Trash2 size={16} />
              {uiText('workspace:detailDeleteRoutine')}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
