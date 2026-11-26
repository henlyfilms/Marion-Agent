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
const SPRING = 'linear(0, 0.063 2.6%, 0.247 5.9%, 0.512 10.4%, 0.739 15.2%, 0.886 20%, 0.968 25%, 1.009 30.4%, 1.024 36%, 1.022 43%, 1.011 52%, 1.003 64%, 1)';
const previousPill = { width: 0 };

export function useViewSwap(view: string, botId: string | null, enabled: boolean) {
  const last = useRef<{ view: string; botId: string | null } | null>(null);
  useLayoutEffect(() => {
    const before = last.current;
    last.current = { view, botId };
    if (!before || !enabled || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      previousPill.width = document.querySelector<HTMLElement>('.app > .chat .chat__pill')?.getBoundingClientRect().width ?? 0;
      return;
    }
    const main = document.querySelector<HTMLElement>('.app > .chat');
    if (!main) return;
    if (before.view !== view) {
      // Changing view (chat, Tasks, Sessions): a plain crossfade, no push or zoom.
      main.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: OUT });
    } else if (before.botId !== botId && view === 'chat') {
      // Switching bots: the conversation surfaces out of a soft blur while the bot pill reshapes
      // around the new name, like an iOS live-activity pill.
      const transcript = main.querySelector<HTMLElement>('.transcript__col');
      transcript?.animate([
        { opacity: 0, transform: 'translateY(14px)', filter: 'blur(8px)' },
        { opacity: 1, transform: 'none', filter: 'blur(0)' },
      ], { duration: 520, easing: IOS });
      const pill = main.querySelector<HTMLElement>('.chat__pill');
      if (pill) {
        const from = previousPill.width;
        const to = pill.getBoundingClientRect().width;
        if (from && Math.abs(from - to) > 1) pill.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: 520, easing: SPRING });
        pill.animate([{ transform: 'scale(0.94)' }, { transform: 'none' }], { duration: 520, easing: SPRING });
        for (const child of pill.children) {
          (child as HTMLElement).animate([{ opacity: 0, filter: 'blur(5px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 360, easing: OUT, delay: 60, fill: 'backwards' });
        }
      }
      for (const el of document.querySelectorAll<HTMLElement>('.app.has-details .details__navigation, .app.has-details .details__scroll')) {
        el.animate([{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 360, easing: OUT });
      }
    }
    previousPill.width = main.querySelector<HTMLElement>('.chat__pill')?.getBoundingClientRect().width ?? 0;
  }, [view, botId, enabled]);
}
