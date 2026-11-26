import { useEffect, useRef, type RefObject } from 'react';
import { clampIndex, findMatches, isBlankQuery, joinParts, locate, MAX_MATCHES, nearestIndex, type TextPart } from './chatSearch';
import { useChatSearch } from './chatSearchStore';

// Browser side of in-chat search. Matches are painted with the CSS Custom Highlight API (`::highlight(chat-search)`),
// which colours text ranges without touching the DOM, so markdown, links, code blocks, selection and React's own
// rendering are left exactly as they were.

/** Parts of the transcript whose text is searched. */
const TARGETS = '.bubble, .system-event, .notice';
/** Text inside these is a copy of another message or chrome, not message content. */
const SKIP = '.bubble__reply, .bubble__usage';
const BLOCK = 'p, li, pre, div, h1, h2, h3, h4, h5, h6, blockquote, td, th, tr, table, ul, ol, hr, br';

export interface DomMatch { range: Range; el: HTMLElement; start: number }

/** Every match for `query` under `root`, in reading order. */
export function collectMatches(root: HTMLElement, query: string): DomMatch[] {
  const out: DomMatch[] = [];
  if (isBlankQuery(query)) return out;
  for (const el of root.querySelectorAll<HTMLElement>(TARGETS)) {
    if (out.length >= MAX_MATCHES) break;
    const nodes: Text[] = [];
    const parts: TextPart[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP) || parent.closest('script, style')) continue;
      nodes.push(node);
      parts.push({ text: node.data, block: parent.closest(BLOCK) });
    }
    if (!nodes.length) continue;
    const { text, segments } = joinParts(parts);
    for (const span of findMatches(text, query, MAX_MATCHES - out.length)) {
      const from = locate(segments, span.start, 'start');
      const to = locate(segments, span.end, 'end');
      if (!from || !to) continue;
      const range = document.createRange();
      range.setStart(nodes[from.segment], from.offset);
      range.setEnd(nodes[to.segment], to.offset);
      out.push({ range, el, start: span.start });
    }
  }
  return out;
}

interface HighlightLike { priority: number; add(range: Range): unknown }
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;
const registry = () => (typeof CSS === 'undefined' ? undefined : (CSS as unknown as { highlights?: Map<string, HighlightLike> }).highlights);
const highlightCtor = () => (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;

export function clearHighlights() {
  const reg = registry();
  reg?.delete('chat-search');
  reg?.delete('chat-search-active');
}

/** Paints every match, and the current one on top with a stronger colour. */
export function paintHighlights(matches: DomMatch[], active: number) {
  const reg = registry();
  const Highlight = highlightCtor();
  if (!reg || !Highlight) return;
  if (!matches.length) { clearHighlights(); return; }
  reg.set('chat-search', new Highlight(...matches.map(m => m.range)));
  const current = matches[clampIndex(active, matches.length)];
  const top = new Highlight(current.range);
  top.priority = 1;
  reg.set('chat-search-active', top);
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const firstRect = (range: Range) => range.getClientRects()[0] ?? range.getBoundingClientRect();

/** Where the chat is actually readable: below the floating header and above the floating message box. */
function readableBand(scroller: HTMLElement) {
  const box = scroller.getBoundingClientRect();
  const style = getComputedStyle(scroller);
  const top = box.top + (parseFloat(style.paddingTop) || 0);
  const bottom = box.bottom - (parseFloat(style.paddingBottom) || 0);
  return { top, bottom: Math.max(bottom, top + 40) };
}

/** Glides the chat so the match sits in the middle of the readable area, even when it is deep inside a long message. */
export function revealRange(scroller: HTMLElement, range: Range) {
  const rect = firstRect(range);
  if (!rect.width && !rect.height) return;
  const band = readableBand(scroller);
  const delta = rect.top + rect.height / 2 - (band.top + band.bottom) / 2;
  if (Math.abs(delta) < 2) return;
  scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

/**
 * Keeps the transcript's matches, highlights and scroll position in step with the search bar.
 * `scrollRef` is the scrolling transcript. `beforeReveal` runs just before the chat scrolls to a match, so the
 * "stay pinned to the newest message" behaviour can step aside instead of fighting the scroll.
 */
export function useChatSearchHighlights(scrollRef: RefObject<HTMLElement>, botId: string, beforeReveal: () => void) {
  const open = useChatSearch(s => s.open);
  const query = useChatSearch(s => s.query);
  const navTick = useChatSearch(s => s.navTick);
  const live = open && !isBlankQuery(query);
  const matches = useRef<DomMatch[]>([]);
  const before = useRef(beforeReveal);
  before.current = beforeReveal;

  const reveal = (match: DomMatch | undefined) => {
    const scroller = scrollRef.current;
    if (!scroller || !match) return;
    before.current();
    revealRange(scroller, match.range);
  };

  // A new or changed search: find everything, start at the match closest to what you are looking at, glide to it.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!live || !scroller) { matches.current = []; clearHighlights(); useChatSearch.getState().setResult(0, 0); return; }
    const found = collectMatches(scroller, query);
    matches.current = found;
    const band = readableBand(scroller);
    const active = found.length ? nearestIndex(found.map(m => firstRect(m.range).top), (band.top + band.bottom) / 2) : 0;
    useChatSearch.getState().setResult(found.length, active);
    paintHighlights(found, active);
    reveal(found[active]);
    return clearHighlights;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, query, botId]);

  // Next / previous: move the bright highlight and glide to it.
  const lastNav = useRef(navTick);
  useEffect(() => {
    if (lastNav.current === navTick) return;
    lastNav.current = navTick;
    const { active } = useChatSearch.getState();
    paintHighlights(matches.current, active);
    reveal(matches.current[active]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navTick]);

  // Messages arriving or streaming in: re-count and re-paint, keep the current match, and do not move the chat.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!live || !scroller) return;
    let timer = 0;
    const refresh = () => {
      timer = 0;
      const previous = matches.current[useChatSearch.getState().active];
      const found = collectMatches(scroller, useChatSearch.getState().query);
      const same = previous ? found.findIndex(m => m.el === previous.el && m.start === previous.start) : -1;
      const active = same >= 0 ? same : clampIndex(useChatSearch.getState().active, found.length);
      matches.current = found;
      useChatSearch.getState().setResult(found.length, active);
      paintHighlights(found, active);
    };
    const observer = new MutationObserver(() => { if (!timer) timer = window.setTimeout(refresh, 180); });
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [live, botId, scrollRef]);
}
