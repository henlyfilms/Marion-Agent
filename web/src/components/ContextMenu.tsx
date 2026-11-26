import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type TouchEvent } from 'react';
import { leaveGhost } from '../lib/exitGhost';
import { createPortal } from 'react-dom';
import { MenuItems, type MenuItem } from './Menu';

interface MenuTarget {
  label: string;
  items: MenuItem[];
  trigger: HTMLElement;
  x: number;
  y: number;
}

const ContextMenu = createContext<(target: MenuTarget) => void>(() => {});
const nativeTargets = 'a[href], input, textarea, select, [contenteditable]:not([contenteditable="false"])';

const LONG_PRESS_MS = 450;
const PRESS_SLOP = 10;
let press: { timer: number; x: number; y: number } | null = null;
let lastOpenAt = 0;
const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };

export function useContextMenu() {
  const open = useContext(ContextMenu);
  return (label: string, getItems: () => MenuItem[], opts: { longPress?: boolean } = {}) => ({
    'aria-haspopup': 'menu' as const,
    // iPhone / touch: holding a finger still for ~0.45 s opens the same menu. Moving (scrolling) or lifting early cancels it.
    ...(opts.longPress ? {
      onTouchStart(event: TouchEvent<HTMLElement>) {
        cancelPress();
        if (event.touches.length !== 1 || (event.target as Element).closest(nativeTargets)) return;
        const { clientX: x, clientY: y } = event.touches[0];
        const trigger = event.currentTarget;
        press = { x, y, timer: window.setTimeout(() => {
          press = null;
          const items = getItems();
          if (!items.length) return;
          window.getSelection()?.removeAllRanges();
          navigator.vibrate?.(8);
          lastOpenAt = Date.now();
          open({ label, items, trigger, x, y });
        }, LONG_PRESS_MS) };
      },
      onTouchMove(event: TouchEvent<HTMLElement>) {
        const touch = event.touches[0];
        if (press && touch && Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > PRESS_SLOP) cancelPress();
      },
      onTouchEnd: cancelPress,
      onTouchCancel: cancelPress,
    } : {}),
    onContextMenu(event: MouseEvent<HTMLElement>) {
      if (event.defaultPrevented || (event.target as Element).closest(nativeTargets)) return;
      const items = getItems();
      if (!items.length) return;
      event.preventDefault();
      event.stopPropagation();
      open({ label, items, trigger: event.currentTarget, x: event.clientX, y: event.clientY });
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.target !== event.currentTarget || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return;
      const items = getItems();
      if (!items.length) return;
      event.preventDefault();
      event.stopPropagation();
      const { left, bottom } = event.currentTarget.getBoundingClientRect();
      open({ label, items, trigger: event.currentTarget, x: left, y: bottom });
    },
  });
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<MenuTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = useCallback((next: MenuTarget) => {
    setError(null);
    leaveGhost(menuRef.current, 180);
    setTarget(next);
  }, []);

  const close = (restoreFocus = false) => {
    if (restoreFocus && target?.trigger.isConnected) target.trigger.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    leaveGhost(menuRef.current, 180);
    setTarget(null);
  };

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!target || !menu) return;
    const inset = 8;
    menu.style.left = `${Math.max(inset, Math.min(target.x, window.innerWidth - menu.offsetWidth - inset))}px`;
    menu.style.top = `${Math.max(inset, Math.min(target.y, window.innerHeight - menu.offsetHeight - inset))}px`;
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const dismiss = (event: Event) => {
      // The finger that held down to open the menu is still on the screen for a moment; its wobble must not close it.
      if (event.type === 'touchmove' && Date.now() - lastOpenAt < 900) return;
      if (!menuRef.current?.contains(event.target as Node)) { leaveGhost(menuRef.current, 180); setTarget(null); }
    };
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('wheel', dismiss, { capture: true, passive: true });
    window.addEventListener('touchmove', dismiss, { capture: true, passive: true });
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('wheel', dismiss, true);
      window.removeEventListener('touchmove', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [target]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.stopPropagation();
      if (event.key === 'Escape') event.preventDefault();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const select = async (item: MenuItem) => {
    // Lifting the finger that held down to open the menu can land a click on an item under it; ignore that one.
    if (Date.now() - lastOpenAt < 400) return;
    close(true);
    try {
      await item.onSelect();
    } catch (cause) {
      const detail = cause instanceof Error && cause.message ? ` · ${cause.message}` : '';
      setError(`Couldn’t complete “${item.label}”${detail}`);
    }
  };

  return (
    <ContextMenu.Provider value={open}>
      {children}
      {target && createPortal(
        <div ref={menuRef} role="menu" aria-label={target.label} className="menu context-menu"
          onKeyDown={navigate} onContextMenu={(event) => event.preventDefault()}>
          <MenuItems items={target.items} onSelect={select} tabIndex={-1} />
        </div>,
        document.body,
      )}
      {error && createPortal(<div className="toast context-menu-error" role="alert">{error}</div>, document.body)}
    </ContextMenu.Provider>
  );
}
