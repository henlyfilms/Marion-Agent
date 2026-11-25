import { useLayoutEffect, useRef } from 'react';

/**
 * Plays the entrance of the main column when what it shows changes: switching bots, or going to
 * Tasks / Sessions and back. Uses the Web Animations API on the element that's already there, so the
 * chat never remounts and nothing moves on first paint (motion-graphics skill, rule 6).
 *
 * - Switching bots: the new conversation crossfades up a touch, like Duet switching chats.
 * - Changing view: the new view pushes in from the right; going back to the chat comes from the left.
 */
const IOS = 'cubic-bezier(0.32, 0.72, 0, 1)';
const OUT = 'cubic-bezier(0.2, 0, 0, 1)';
const ORDER = ['chat', 'tasks', 'sessions'];

export function useViewSwap(view: string, botId: string | null, enabled: boolean) {
  const last = useRef<{ view: string; botId: string | null } | null>(null);
  useLayoutEffect(() => {
    const before = last.current;
    last.current = { view, botId };
    if (!before || !enabled || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const main = document.querySelector<HTMLElement>('.app > .chat');
    if (!main) return;
    if (before.view !== view) {
      const from = ORDER.indexOf(view) > ORDER.indexOf(before.view) ? 24 : -24;
      main.animate([{ transform: `translateX(${from}px)` }, { transform: 'none' }], { duration: 460, easing: IOS });
      main.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: OUT });
    } else if (before.botId !== botId && view === 'chat') {
      for (const el of [main.querySelector<HTMLElement>('.transcript'), main.querySelector<HTMLElement>('.chat__header-main')]) {
        if (!el) continue;
        el.animate([{ transform: 'translateY(8px)' }, { transform: 'none' }], { duration: 420, easing: IOS });
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: OUT });
      }
      for (const el of document.querySelectorAll<HTMLElement>('.app.has-details .details__navigation, .app.has-details .details__scroll')) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: OUT });
      }
    }
  }, [view, botId, enabled]);
}
