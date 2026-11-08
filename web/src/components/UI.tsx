import { uiText } from '../i18n';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
export function IconButton({
  label,
  children,
  onClick,
  className = '',
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Dialog({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  className = '',
  active = true,
  headerActions,
  portal = false,
  scrollBody = true,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  active?: boolean;
  headerActions?: ReactNode;
  portal?: boolean;
  scrollBody?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll?.('[data-openbot-dialog="active"]');
      if (dialogs?.length && dialogs[dialogs.length - 1] !== ref.current) return;
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const dialog = ref.current;
        if (!dialog) return;
        const nodes = [
          ...dialog.querySelectorAll<HTMLElement>(
            'button,input,textarea,select,a[href],summary,[tabindex],[contenteditable="true"]',
          ),
        ].filter(
          (node) =>
            node.tabIndex >= 0 &&
            !node.matches(':disabled') &&
            !node.closest('[inert]') &&
            node.getClientRects().length > 0 &&
            getComputedStyle(node).visibility !== 'hidden',
        );
        if (!nodes.length) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (!nodes.includes(document.activeElement as HTMLElement)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      prev?.focus();
    };
  }, [active]);
  const view = (
    <div
      className="modal-overlay"
      style={active ? undefined : { display: 'none' }}
      inert={!active}
      aria-hidden={active ? undefined : true}
      onMouseDown={(e) => {
        if (active && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${scrollBody ? 'modal-scroll-body' : ''} ${wide ? 'modal-wide' : ''} ${className}`}
        role="dialog"
        data-openbot-dialog={active ? 'active' : undefined}
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {headerActions ? (
            <div className="modal-header-actions">
              {headerActions}
              <IconButton label={uiText('common:text_3fd47edce45b')} onClick={onClose}>
                <X size={19} />
              </IconButton>
            </div>
          ) : (
            <IconButton label={uiText('common:text_3fd47edce45b')} onClick={onClose}>
              <X size={19} />
            </IconButton>
          )}
        </header>
        {scrollBody ? <div className="modal-body">{children}</div> : children}
      </div>
    </div>
  );
  return portal && typeof document !== 'undefined' && document.body
    ? createPortal(view, document.body)
    : view;
}
