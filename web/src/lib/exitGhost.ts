import { useLayoutEffect, type RefObject } from 'react';

/**
 * Exit animations for things React removes instantly (modals, menus, popovers).
 * Right before the real element leaves the page, a frozen copy takes its place, gets `is-leaving`,
 * plays the CSS exit, then removes itself. Callers keep closing the normal way (setState → unmount),
 * so every close path (Esc, scrim click, a Done button, picking a menu item) animates the same.
 */
const lastGhost = new WeakMap<HTMLElement, number>();

export function leaveGhost(node: HTMLElement | null, ms = 300) {
  if (!node?.isConnected || !node.parentNode) return;
  if (performance.now() - (lastGhost.get(node) ?? -1e9) < 120) return; // one close, one copy
  lastGhost.set(node, performance.now());
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ghost = node.cloneNode(true) as HTMLElement;
  ghost.classList.add('is-leaving');
  ghost.inert = true;
  ghost.setAttribute('aria-hidden', 'true');
  for (const el of [ghost, ...ghost.querySelectorAll('[aria-modal], [id]')]) { el.removeAttribute('aria-modal'); el.removeAttribute('id'); }
  // Keep scrolled lists where they were, so the copy doesn't jump to the top while it fades.
  const from = [node, ...node.querySelectorAll<HTMLElement>('*')];
  const to = [ghost, ...ghost.querySelectorAll<HTMLElement>('*')];
  node.after(ghost);
  from.forEach((el, i) => { if (el.scrollTop || el.scrollLeft) { to[i].scrollTop = el.scrollTop; to[i].scrollLeft = el.scrollLeft; } });
  window.setTimeout(() => ghost.remove(), ms);
}

/** Leave a fading copy behind when this component unmounts. Ignores StrictMode's instant re-mount in dev. */
export function useExitGhost(ref: RefObject<HTMLElement | null>, ms = 300) {
  useLayoutEffect(() => {
    const node = ref.current;
    const born = performance.now();
    return () => { if (performance.now() - born > 80) leaveGhost(node, ms); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
