import { Fragment, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useExitGhost } from '../lib/exitGhost';

export interface MenuItem {
  label: string;
  onSelect: () => void | Promise<unknown>;
  danger?: boolean;
  hint?: string;
  separator?: boolean;
  icon?: ReactNode;
  group?: string;
  detail?: string;
  checked?: boolean;
  disabled?: boolean;
}

export function MenuItems({ items, onSelect, tabIndex }: { items: MenuItem[]; onSelect: (item: MenuItem) => void; tabIndex?: number }) {
  return items.map((item, index) => (
    <Fragment key={`${item.group ?? ''}:${item.label}`}>
    {item.group && items[index - 1]?.group !== item.group && <div className="menu__header" role="presentation">{item.group}</div>}
    <button type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} tabIndex={tabIndex}
      aria-checked={item.checked} disabled={item.disabled}
      className={`menu__item${item.danger ? ' is-danger' : ''}${item.separator ? ' is-separated' : ''}`}
      onClick={() => onSelect(item)}>
      {item.icon}
      <span className="menu__item-copy">
        <span>{item.label}</span>
        {item.detail && <small>{item.detail}</small>}
      </span>
      {item.hint && <span className="menu__hint">{item.hint}</span>}
      {item.checked && <Icon name="check" size={15} />}
    </button>
    </Fragment>
  ));
}

/** Small popover menu anchored by its parent (position: relative). Closes on outside click / Escape. */
export function Menu({ items, onClose, align = 'left', placement = 'below', children, label, className = '' }: { items: MenuItem[]; onClose: () => void; align?: 'left' | 'right' | 'center'; placement?: 'below' | 'above'; children?: ReactNode; label?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useExitGhost(ref, 180);
  const trigger = useRef(document.activeElement);
  // In the Mac window, clicks on a draggable title strip never reach the page, so "click beside the menu to close it"
  // did nothing there (owner, Nov 25). While a menu is open the strips stop dragging and take the click instead.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.openMenus = String(Number(root.dataset.openMenus ?? 0) + 1);
    return () => {
      const left = Number(root.dataset.openMenus ?? 1) - 1;
      if (left > 0) root.dataset.openMenus = String(left); else delete root.dataset.openMenus;
    };
  }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose(); };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (trigger.current instanceof HTMLElement) trigger.current.focus({ preventScroll: true });
      onClose();
    };
    const t = setTimeout(() => document.addEventListener('mousedown', down));
    document.addEventListener('keydown', key, true);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  useEffect(() => {
    if (label) ref.current?.querySelector<HTMLButtonElement>('.menu__item:not(:disabled)')?.focus({ preventScroll: true });
  }, [label]);
  const navigate = (event: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('.menu__item:not(:disabled)') ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };
  return (
    <div ref={ref} className={`menu is-${align} is-${placement} ${className}`} role="menu" aria-label={label} onKeyDown={navigate}>
      {children}
      <MenuItems items={items} onSelect={(item) => { onClose(); item.onSelect(); }} />
    </div>
  );
}
