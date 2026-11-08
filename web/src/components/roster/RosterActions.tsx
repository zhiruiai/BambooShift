import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import '../SidebarRoster.css';
import { MenuAction } from './types';
export function RosterActions({
  children,
  label,
  actions,
}: {
  children: ReactNode;
  label: string;
  actions: MenuAction[];
}) {
  const [position, setPosition] = useState<{ left: number; top: number }>(),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  function show(x: number, y: number) {
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - 236)),
      top: Math.max(8, Math.min(y, window.innerHeight - actions.length * 45 - 20)),
    });
  }
  useEffect(() => {
    if (!position) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setPosition(undefined);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [position]);
  return (
    <div
      ref={root}
      className="roster-action-host"
      onContextMenu={(event) => {
        event.preventDefault();
        show(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const rect = trigger.current!.getBoundingClientRect();
          show(rect.right - 226, rect.bottom + 4);
        }
        if (event.key === 'Escape' && position) {
          event.preventDefault();
          event.stopPropagation();
          setPosition(undefined);
          trigger.current?.focus();
        }
        if (position && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const nodes = Array.from(
              root.current?.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled)',
              ) || [],
            ),
            index = nodes.indexOf(document.activeElement as HTMLButtonElement),
            next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? nodes.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length;
          nodes[next]?.focus();
        }
      }}
    >
      {children}
      <button
        type="button"
        ref={trigger}
        className="icon-button roster-more"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!position}
        onClick={() => {
          if (position) setPosition(undefined);
          else {
            const rect = trigger.current!.getBoundingClientRect();
            show(rect.right - 226, rect.bottom + 4);
          }
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      {position && (
        <div
          role="menu"
          aria-label={label}
          className="dropdown-menu roster-menu"
          style={{ position: 'fixed', ...position }}
        >
          {actions.map((item) => (
            <button
              type="button"
              role="menuitem"
              key={item.label}
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                setPosition(undefined);
                trigger.current?.focus();
                item.action();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
