import { useLayoutEffect, useRef } from 'react';

/**
 * Plays the entrance of the main column when what it shows changes: switching bots, or going to
 * Tasks / Sessions and back. Uses the Web Animations API on the element that's already there, so the
 * chat never remounts and nothing moves on first paint (motion-graphics skill, rule 6).
 *
 * - Switching bots: the bot pill morphs like an iPhone Dynamic Island. The old avatar + name lift
 *   away while the pill springs to its new width, then the new ones settle in. The name is never
 *   squeezed into "…" mid-morph. The conversation rises in with opacity + transform only (no blur
 *   on big areas, which made switching lag).
 * - Changing view: a plain crossfade.
 */
const IOS = 'cubic-bezier(0.32, 0.72, 0, 1)';
const OUT = 'cubic-bezier(0.2, 0, 0, 1)';
const EXIT = 'cubic-bezier(0.4, 0, 1, 1)';
const SPRING = 'linear(0, 0.063 2.6%, 0.247 5.9%, 0.512 10.4%, 0.739 15.2%, 0.886 20%, 0.968 25%, 1.009 30.4%, 1.024 36%, 1.022 43%, 1.011 52%, 1.003 64%, 1)';
const MORPH_MS = 480;

/** What the pill looked like last time we saw it, so the next switch can morph from it. */
const last = { width: 0, content: null as DocumentFragment | null, pill: null as HTMLElement | null };
let observer: ResizeObserver | null = null;
let morphTimer = 0;

function snapshot(pill: HTMLElement | null) {
  if (!pill) { last.width = 0; last.content = null; return; }
  if (pill.classList.contains('is-morphing')) return; // mid-morph sizes aren't the resting state
  last.width = pill.getBoundingClientRect().width;
  const frag = document.createDocumentFragment();
  for (const child of pill.children) if (!child.classList.contains('chat__pill-ghost')) frag.append(child.cloneNode(true));
  last.content = frag;
}

/** Keep the snapshot fresh when the pill changes size for other reasons (rename, window resize). */
function watch(pill: HTMLElement | null) {
  if (pill === last.pill) return;
  observer?.disconnect();
  last.pill = pill;
  if (!pill) return;
  observer ??= new ResizeObserver(() => snapshot(last.pill));
  observer.observe(pill);
}

/** The old avatar's SVG gradients share ids with the new one; give the ghost its own so it keeps its colours. */
function renameIds(root: Element) {
  const ids = [...root.querySelectorAll('[id]')].map(el => { const id = el.id; el.id = `${id}-ghost`; return id; });
  if (!ids.length) return;
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (!attr.value.includes('#')) continue;
      let v = attr.value;
      for (const id of ids) v = v.split(`#${id})`).join(`#${id}-ghost)`).replace(new RegExp(`^#${id}$`), `#${id}-ghost`);
      if (v !== attr.value) el.setAttribute(attr.name, v);
    }
  }
}

function morphPill(pill: HTMLElement) {
  const from = last.width;
  const ghostContent = last.content;
  // A quick second switch: stop the previous morph where it is.
  clearTimeout(morphTimer);
  pill.querySelectorAll('.chat__pill-ghost').forEach(g => g.remove());
  pill.getAnimations({ subtree: true }).forEach(a => a.cancel());

  pill.classList.add('is-morphing');
  const to = pill.getBoundingClientRect().width;
  if (from && Math.abs(from - to) > 1) {
    pill.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: MORPH_MS, easing: SPRING });
  }
  pill.animate([{ transform: 'scale(0.965)' }, { transform: 'none' }], { duration: MORPH_MS, easing: SPRING });

  if (ghostContent) {
    const ghost = document.createElement('span');
    ghost.className = 'chat__pill-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.append(ghostContent.cloneNode(true));
    renameIds(ghost);
    pill.append(ghost);
    ghost.animate([
      { opacity: 1, transform: 'none', filter: 'blur(0)' },
      { opacity: 0, transform: 'translateY(-7px) scale(0.96)', filter: 'blur(3px)' },
    ], { duration: 190, easing: EXIT, fill: 'forwards' }).finished.then(() => ghost.remove(), () => ghost.remove());
  }
  for (const child of pill.children) {
    if (child.classList.contains('chat__pill-ghost')) continue;
    (child as HTMLElement).animate([
      { opacity: 0, transform: 'translateY(7px) scale(0.96)', filter: 'blur(3px)' },
      { opacity: 1, transform: 'none', filter: 'blur(0)' },
    ], { duration: 380, delay: 110, easing: IOS, fill: 'backwards' });
  }
  morphTimer = window.setTimeout(() => { pill.classList.remove('is-morphing'); snapshot(pill); }, MORPH_MS + 20);
}

export function useViewSwap(view: string, botId: string | null, enabled: boolean) {
  const prev = useRef<{ view: string; botId: string | null } | null>(null);
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = { view, botId };
    const main = document.querySelector<HTMLElement>('.app > .chat');
    const pill = main?.querySelector<HTMLElement>('.chat__pill') ?? null;
    const still = !before || !enabled || matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!still && main) {
      if (before.view !== view) {
        main.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: OUT });
      } else if (before.botId !== botId && view === 'chat') {
        if (pill) morphPill(pill);
        main.querySelector<HTMLElement>('.transcript__col')?.animate([
          { opacity: 0, transform: 'translateY(12px)' },
          { opacity: 1, transform: 'none' },
        ], { duration: 420, easing: IOS });
        for (const el of document.querySelectorAll<HTMLElement>('.app.has-details .details__navigation, .app.has-details .details__scroll')) {
          el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: OUT });
        }
      }
    }
    watch(pill);
    snapshot(pill);
  }, [view, botId, enabled]);
}
