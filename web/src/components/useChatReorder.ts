import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

export interface ChatMove { id: string; targetId: string; after: boolean }

interface Gesture {
  row: HTMLElement;
  list: HTMLElement;
  scroller: HTMLElement;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  y: number;
  scrollStart: number;
  rows: HTMLElement[];
  active: boolean;
  timer?: ReturnType<typeof setTimeout>;
  frame?: number;
  drop?: ChatMove;
}

export function useChatReorder(move: (move: ChatMove) => void, closeSwipe: () => void, disabled: boolean) {
  const list = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture>();
  const suppressClick = useRef(0);
  const dropPositions = useRef<Map<string, number>>();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const node = list.current;
    const preventScroll = (event: TouchEvent) => {
      if (gesture.current?.active && event.cancelable) event.preventDefault();
    };
    node?.addEventListener('touchmove', preventScroll, { passive: false });
    return () => {
      node?.removeEventListener('touchmove', preventScroll);
      clearTimeout(gesture.current?.timer);
      if (gesture.current?.frame !== undefined) cancelAnimationFrame(gesture.current.frame);
    };
  }, []);

  const update = (g: Gesture) => {
    const offset = g.y - g.startY + g.scroller.scrollTop - g.scrollStart;
    const sourceIndex = g.rows.indexOf(g.row);
    const center = g.row.offsetTop + g.row.offsetHeight / 2 + offset;
    const crossed = (row: HTMLElement) => row.offsetTop + row.offsetHeight / 2;
    const targetIndex = offset < 0
      ? g.rows.findIndex((row, index) => index < sourceIndex && center < crossed(row))
      : g.rows.findLastIndex((row, index) => index > sourceIndex && center > crossed(row));
    const target = g.rows[targetIndex];
    const after = offset > 0;
    const nextDrop = target && { id: g.row.dataset.chatId!, targetId: target.dataset.chatId!, after };
    g.row.style.setProperty('--reorder-y', `${offset}px`);
    if (g.drop?.targetId === nextDrop?.targetId && g.drop?.after === nextDrop?.after) return;
    g.drop = nextDrop;
    const gap = parseFloat(getComputedStyle(g.list).rowGap) || 0;
    const shift = (g.row.offsetHeight + gap) * (after ? -1 : 1);
    const first = Math.min(sourceIndex, targetIndex);
    const last = Math.max(sourceIndex, targetIndex);
    g.rows.forEach((row, index) => {
      if (row === g.row) return;
      row.style.translate = target && index >= first && index <= last ? `0 ${shift}px` : '';
    });
  };

  const activate = (g: Gesture) => {
    if (g.active || gesture.current !== g) return;
    clearTimeout(g.timer);
    g.active = true;
    g.list.setPointerCapture(g.pointerId);
    closeSwipe();
    g.rows = [...g.list.querySelectorAll<HTMLElement>('[data-chat-id]')].filter(row =>
      row.offsetHeight > 0 && row.dataset.starred === g.row.dataset.starred);
    g.rows.forEach(row => row.getAnimations().forEach(animation => animation.cancel()));
    g.row.classList.add('is-moving');
    g.list.classList.add('is-reordering');
    setDragging(true);
    let lastTime = performance.now();
    let lastY = g.startY;
    let lastScroll = g.scrollStart;
    const scroll = (now: number) => {
      if (gesture.current !== g) return;
      const { top, bottom } = g.scroller.getBoundingClientRect();
      const edge = 48;
      const delta = g.y < top + edge ? -Math.min(12, (top + edge - g.y) / 4)
        : g.y > bottom - edge ? Math.min(12, (g.y - bottom + edge) / 4) : 0;
      if (delta) g.scroller.scrollTop += delta * Math.min(2, (now - lastTime) / (1000 / 60));
      if (g.y !== lastY || g.scroller.scrollTop !== lastScroll) update(g);
      lastY = g.y;
      lastScroll = g.scroller.scrollTop;
      lastTime = now;
      g.frame = requestAnimationFrame(scroll);
    };
    g.frame = requestAnimationFrame(scroll);
  };

  const finish = (event: PointerEvent, commit: boolean) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = undefined;
    clearTimeout(g.timer);
    if (!g.active) return;
    if (g.frame !== undefined) cancelAnimationFrame(g.frame);
    if (g.list.hasPointerCapture(g.pointerId)) g.list.releasePointerCapture(g.pointerId);
    if (commit) {
      g.y = event.clientY;
      update(g);
    }
    dropPositions.current = new Map([...g.list.querySelectorAll<HTMLElement>('[data-chat-id]')]
      .filter(row => row.offsetHeight > 0)
      .map(row => [row.dataset.chatId!, row.getBoundingClientRect().top]));
    g.row.classList.remove('is-moving');
    g.row.style.removeProperty('--reorder-y');
    g.list.classList.remove('is-reordering');
    g.rows.forEach(row => { row.style.translate = ''; });
    setDragging(false);
    suppressClick.current = performance.now() + 300;
    if (commit && g.drop) move(g.drop);
  };

  return {
    list,
    dropPositions,
    dragging,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (disabled || !event.isPrimary || event.button !== 0 || gesture.current) return;
        suppressClick.current = 0;
        const row = (event.target as HTMLElement).closest<HTMLElement>('.bot-row')?.closest<HTMLElement>('[data-chat-id]');
        const scroller = event.currentTarget.parentElement;
        if (!row || !scroller) return;
        const g: Gesture = {
          row, list: event.currentTarget, scroller, pointerId: event.pointerId, pointerType: event.pointerType,
          startX: event.clientX, startY: event.clientY, y: event.clientY, scrollStart: scroller.scrollTop, rows: [], active: false,
        };
        gesture.current = g;
        g.timer = setTimeout(() => activate(g), event.pointerType === 'touch' ? 360 : 240);
      },
      onPointerMoveCapture: (event: PointerEvent<HTMLDivElement>) => {
        const g = gesture.current;
        if (!g || g.pointerId !== event.pointerId) return;
        g.y = event.clientY;
        if (!g.active) {
          const moved = Math.hypot(event.clientX - g.startX, event.clientY - g.startY);
          if (moved < 7) return;
          if (g.pointerType === 'touch') { finish(event, false); return; }
          activate(g);
        }
        event.stopPropagation();
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finish(event, false),
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) finish(event, false);
      },
      onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
        if (!gesture.current?.active) finish(event, false);
      },
      onContextMenuCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (gesture.current?.pointerType !== 'touch' && !gesture.current?.active) return;
        event.preventDefault();
        event.stopPropagation();
      },
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (event.detail === 0 || performance.now() >= suppressClick.current) return;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
