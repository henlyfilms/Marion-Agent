import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Switching chats in the sidebar: the selected highlight glides from the old row to the new one and
 * settles softly (the owner's Marion Life sidebar, recorded Nov 25). One temporary "glider" sits behind
 * the rows while it travels; the rows' own backgrounds are cleared only for that moment, then the new
 * row's highlight takes over as the glider fades.
 */
const SPRING = 'linear(0, 0.063 2.6%, 0.247 5.9%, 0.512 10.4%, 0.739 15.2%, 0.886 20%, 0.968 25%, 1.009 30.4%, 1.024 36%, 1.022 43%, 1.011 52%, 1.003 64%, 1)';
const GLIDE_MS = 380;
const HANDOFF_MS = 150;

function rowFor(list: HTMLElement, id: string) {
  const wrap = [...list.querySelectorAll<HTMLElement>(':scope > [data-chat-id]')].find(el => el.dataset.chatId === id);
  const row = wrap?.querySelector<HTMLElement>('.bot-row');
  return row && row.offsetHeight ? row : null;
}

export function useSelectionGlide(list: RefObject<HTMLElement>, selectedId: string | null) {
  const prev = useRef<string | null>(null);
  const timer = useRef(0);
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = selectedId;
    const el = list.current;
    if (!el || !before || !selectedId || before === selectedId) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const to = rowFor(el, selectedId);
    if (!to) return;
    const box = el.getBoundingClientRect();
    // A quick second click starts from wherever the glider is right now.
    const old = el.querySelector<HTMLElement>(':scope > .bot-list__glider');
    const fromRect = old?.getBoundingClientRect() ?? rowFor(el, before)?.getBoundingClientRect();
    old?.remove();
    if (!fromRect) return;
    const toRect = to.getBoundingClientRect();
    if (Math.abs(fromRect.top - toRect.top) < 1) return;

    const glider = document.createElement('div');
    glider.className = 'bot-list__glider';
    glider.setAttribute('aria-hidden', 'true');
    Object.assign(glider.style, {
      top: `${toRect.top - box.top}px`, left: `${toRect.left - box.left}px`,
      width: `${toRect.width}px`, height: `${toRect.height}px`,
    });
    el.prepend(glider);
    el.classList.add('is-gliding');
    glider.animate([
      { transform: `translateY(${fromRect.top - toRect.top}px)`, height: `${fromRect.height}px` },
      { transform: 'none', height: `${toRect.height}px` },
    ], { duration: GLIDE_MS, easing: SPRING });

    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // Hand over to the row's own highlight: it fades in while the glider fades out.
      el.classList.remove('is-gliding');
      glider.animate([{ opacity: 1 }, { opacity: 0 }], { duration: HANDOFF_MS, easing: 'linear', fill: 'forwards' })
        .finished.then(() => glider.remove(), () => glider.remove());
    }, GLIDE_MS - 60);
  }, [list, selectedId]);
  useLayoutEffect(() => () => clearTimeout(timer.current), []);
}
