import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Only one color picker is open at a time: opening one tells the others to close. */
export function useOnlyOneOpen(open: boolean, close: () => void) {
  const id = useRef(Math.random());
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onOpen = (event: Event) => { if ((event as CustomEvent<number>).detail !== id.current) closeRef.current(); };
    window.addEventListener('marion-agent:picker-open', onOpen);
    return () => window.removeEventListener('marion-agent:picker-open', onOpen);
  }, []);
  useEffect(() => { if (open) window.dispatchEvent(new CustomEvent('marion-agent:picker-open', { detail: id.current })); }, [open]);
}

/**
 * Smoothly opens and closes an inline panel: it grows from zero height and fades in, and on close it
 * shrinks and fades out before it leaves the page (no instant unmount, no jump in the layout below).
 */
export function Reveal({ open, children, className = '', ms = 320 }: { open: boolean; children: ReactNode; className?: string; ms?: number }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let second = 0;
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setShown(true)); });
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(timer);
  }, [open, ms]);
  useEffect(() => {
    const node = ref.current;
    if (node) node.inert = !open;
  }, [open, mounted]);
  if (!mounted) return null;
  return (
    <div ref={ref} className={`reveal${shown ? ' is-open' : ''}${className ? ` ${className}` : ''}`} aria-hidden={!open || undefined}>
      <div className="reveal__inner">{children}</div>
    </div>
  );
}
