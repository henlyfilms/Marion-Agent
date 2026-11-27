/**
 * "@" bot mentions in the chat composer: when the picker opens, how bots are matched and ranked, how a pick is inserted,
 * and how sent messages show the mentions. Pure functions, so the picker logic is tested without a browser.
 */

export interface MentionCandidate { id: string; name: string; label?: string | null }
export interface MentionQuery {
  /** Index of the "@" in the text. */
  start: number;
  /** Where the typed query ends (the caret). */
  end: number;
  /** What was typed after "@", as typed. */
  query: string;
}

const MAX_QUERY = 40;

/**
 * The mention being typed at the caret, if any. "@" counts only at the start of the text or right after whitespace, so
 * an email address (a@b.com) or a handle inside a word never opens the picker. The query may hold spaces ("@Code Rev")
 * so names with spaces can be filtered; matchMentionBots closes the picker once nothing matches.
 */
export function mentionAt(text: string, caret: number | null | undefined): MentionQuery | null {
  if (caret == null || caret < 1 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY || /[\n@]/.test(query) || /^\s/.test(query) || /\s{2}/.test(query)) return null;
  return { start: at, end: caret, query };
}

const fold = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** How well a bot matches the query: lower is better, null is no match. */
function rank(bot: MentionCandidate, query: string): number | null {
  if (!query) return 5;
  const name = fold(bot.name);
  const label = fold(bot.label ?? '');
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(/[\s._-]+/).some(word => word.startsWith(query))) return 2;
  if (label && (label.startsWith(query) || label.split(/[\s._-]+/).some(word => word.startsWith(query)))) return 3;
  if (!/\s/.test(query) && name.replace(/\s+/g, '').includes(query)) return 4;
  return null;
}

/**
 * Bots for a query, best first: exact name, name prefix, a word of the name, the bot's job (label), then anywhere in the
 * name. Preferred bots (a group chat's members) come first within each rank; ties go alphabetically. Once the query
 * ends in a space right after a bot's full name (just picked or typed out), the picker closes.
 */
export function matchMentionBots<T extends MentionCandidate>(bots: T[], rawQuery: string, options: { prefer?: Set<string>; limit?: number } = {}): T[] {
  const query = fold(rawQuery);
  if (/\s$/.test(query) && bots.some(bot => fold(bot.name) === query.trim())) return [];
  const trimmed = query.trimEnd();
  const prefer = options.prefer ?? new Set<string>();
  return bots
    .map(bot => ({ bot, score: rank(bot, trimmed) }))
    .filter((entry): entry is { bot: T; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || Number(prefer.has(b.bot.id)) - Number(prefer.has(a.bot.id)) || a.bot.name.localeCompare(b.bot.name))
    .slice(0, options.limit ?? 8)
    .map(entry => entry.bot);
}

/** The text with "@Name " in place of the typed mention, and where the caret goes (right after the space). */
export function insertMention(text: string, at: Pick<MentionQuery, 'start' | 'end'>, name: string): { text: string; caret: number } {
  const after = text.slice(at.end);
  const inserted = `@${name}${/^\s/.test(after) ? '' : ' '}`;
  const caret = at.start + inserted.length + (/^\s/.test(after) ? 1 : 0);
  return { text: text.slice(0, at.start) + inserted + after, caret };
}

export interface MentionSegment { text: string; mention?: boolean }

/**
 * A message split into plain text and "@Name" mentions of known bots (longest names first, case-insensitive, only at the
 * start or after whitespace, and only when the name ends there), for highlighting mentions in a sent message.
 */
export function mentionSegments(text: string, names: string[]): MentionSegment[] {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!sorted.length || !text.includes('@')) return [{ text }];
  const escaped = sorted.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(^|\\s)(@(?:${escaped.join('|')}))(?![\\p{L}\\p{N}_])`, 'giu');
  const out: MentionSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[1].length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: match[2], mention: true });
    last = start + match[2].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}
