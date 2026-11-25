import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useExitGhost } from '../../lib/exitGhost';

const focusable = 'button, input, textarea, select, a[href], [tabindex]';

/** Centered dialog with keyboard focus kept inside the active modal. */
export function Modal({ onClose, children, className, label, top }: { onClose: () => void; children: ReactNode; className?: string; label: string; top?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useExitGhost(root);
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current!;
    const targets = () => [...dialog.querySelectorAll<HTMLElement>(focusable)]
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length);
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented || Array.from(document.querySelectorAll('.modal[aria-modal="true"]')).at(-1) !== dialog) return;
      if (e.key === 'Escape') { e.preventDefault(); close.current(); return; }
      if (e.key !== 'Tab') return;
      const options = targets();
      const first = options[0];
      const last = options.at(-1);
      const active = document.activeElement;
      const boundary = e.shiftKey ? first : last;
      if (!active || !options.includes(active as HTMLElement) || active === boundary) {
        e.preventDefault();
        (e.shiftKey ? last ?? dialog : first ?? dialog).focus();
      }
    };
    window.addEventListener('keydown', k);
    const t = setTimeout(() => {
      if (!dialog.contains(document.activeElement)) (targets()[0] ?? dialog).focus();
    });
    return () => {
      window.removeEventListener('keydown', k);
      clearTimeout(t);
      if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div className="modal-root" ref={root}>
      <div className="modal-scrim" onMouseDown={onClose} />
      <div ref={ref} className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} style={top !== undefined ? { marginTop: top } : undefined}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
