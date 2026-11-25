import { useEffect, useLayoutEffect, useRef } from 'react';

/** Put the pill under the active button; without `animate` it snaps (first paint, label width changes). */
function place(pill: HTMLElement, animate: boolean) {
  const host = pill.parentElement;
  const button = host?.querySelector<HTMLElement>('button.is-active');
  pill.style.opacity = button ? '1' : '0';
  if (!host || !button) return;
  const from = host.getBoundingClientRect();
  const to = button.getBoundingClientRect();
  if (!animate) pill.style.transition = 'none';
  pill.style.width = `${to.width}px`;
  pill.style.transform = `translateX(${to.left - from.left - host.clientLeft}px)`;
  if (!animate) { void pill.offsetWidth; pill.style.transition = ''; }
}

/**
 * The sliding highlight inside a `.segmented` control: it glides to the active button
 * instead of jumping. Place it as the control's first child; `active` is the current value.
 */
export function SegmentPill({ active }: { active: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (!ref.current) return;
    place(ref.current, placed.current);
    placed.current = true;
  }, [active]);
  useEffect(() => {
    const pill = ref.current;
    if (!pill?.parentElement) return;
    // Labels can change width (counts, fonts loading): follow without animating. Skip the call
    // the observer makes as soon as it starts, or it would cut the first slide short.
    let first = true;
    const observer = new ResizeObserver(() => { if (first) first = false; else place(pill, false); });
    observer.observe(pill.parentElement);
    return () => observer.disconnect();
  }, []);
  return <span ref={ref} className="segmented__pill" aria-hidden />;
}
