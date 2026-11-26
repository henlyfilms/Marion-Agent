// Pure logic for in-chat search (Cmd/Ctrl+F). No DOM and no imports, so tests/chat-search.mjs can run it in Node.
//
// The page walks the rendered text of every message, joins the text nodes of one message into a single string
// (`joinParts`), finds matches in that string (`findMatches`) and maps each match back onto the text nodes it covers
// (`locate`). Working on the rendered text means markdown (`**bold**`, links, code) never hides or fakes a match.

export interface MatchSpan { start: number; end: number }
/** One text node of a message: its text, plus the block (paragraph, list item, code block…) it sits in. */
export interface TextPart { text: string; block?: unknown }
/** Where a text node starts inside the joined text. */
export interface TextSegment { start: number; length: number }
export interface JoinedText { text: string; segments: TextSegment[] }
export interface TextPosition { segment: number; offset: number }

/** Stops one match from running across two blocks ("end of one paragraph" + "start of the next"). `\s` never matches it. */
export const BLOCK_BREAK = '\u0000';
/** A very common word in a very long chat must not paint tens of thousands of ranges. */
export const MAX_MATCHES = 2000;

export const isBlankQuery = (query: string) => query.trim() === '';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every case-insensitive occurrence of `query` in `text`, in order, never overlapping. Characters in the query are
 * literal (no regex), and a run of spaces in the query also matches a line break in the text (markdown soft wraps).
 */
export function findMatches(text: string, query: string, limit = MAX_MATCHES): MatchSpan[] {
  if (!text || isBlankQuery(query) || limit <= 0) return [];
  let pattern: RegExp;
  try { pattern = new RegExp(escapeRegExp(query).replace(/\s+/g, '\\s+'), 'giu'); } catch { return []; }
  const spans: MatchSpan[] = [];
  for (const m of text.matchAll(pattern)) {
    if (!m[0]) continue;
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (spans.length >= limit) break;
  }
  return spans;
}

/** Joins the text nodes of one message, putting a break between nodes that belong to different blocks. */
export function joinParts(parts: TextPart[]): JoinedText {
  let text = '';
  const segments: TextSegment[] = [];
  parts.forEach((part, i) => {
    if (i > 0 && part.block !== parts[i - 1].block) text += BLOCK_BREAK;
    segments.push({ start: text.length, length: part.text.length });
    text += part.text;
  });
  return { text, segments };
}

/**
 * The text node and offset for a position in the joined text. A match's start belongs to the node it begins in;
 * its end belongs to the node it finishes in (so a match ending exactly at a node's end stays in that node).
 */
export function locate(segments: TextSegment[], position: number, edge: 'start' | 'end'): TextPosition | null {
  for (let i = 0; i < segments.length; i++) {
    const { start, length } = segments[i];
    const inside = edge === 'start' ? position >= start && position < start + length : position > start && position <= start + length;
    if (inside) return { segment: i, offset: position - start };
  }
  return null;
}

/** The next (dir = 1) or previous (dir = -1) match, wrapping around the ends. 0 when there is nothing to step through. */
export function stepIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0;
  const from = Number.isInteger(current) ? Math.min(Math.max(current, 0), count - 1) : 0;
  return (from + dir + count) % count;
}

/** Keeps a remembered match number valid after the list of matches changed length. */
export const clampIndex = (index: number, count: number) => (count <= 0 ? 0 : Math.min(Math.max(Number.isFinite(index) ? Math.trunc(index) : 0, 0), count - 1));

/** The match closest to `target` (for example the middle of the visible chat), so a new search starts where you are looking. */
export function nearestIndex(positions: number[], target: number): number {
  let best = 0;
  let bestDistance = Infinity;
  positions.forEach((position, i) => {
    const distance = Math.abs(position - target);
    if (distance < bestDistance) { best = i; bestDistance = distance; }
  });
  return best;
}

/** "2 / 7" while there are matches, "No matches" for a search that found nothing, "0 / 0" while the box is empty. */
export function matchLabel(query: string, active: number, count: number): string {
  if (isBlankQuery(query)) return '0 / 0';
  if (count <= 0) return 'No matches';
  return `${clampIndex(active, count) + 1} / ${count}`;
}
