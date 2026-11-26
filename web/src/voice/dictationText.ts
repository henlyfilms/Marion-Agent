// Pure text helpers that let dictation and manual typing share one message box.
//
// Rules the chat box follows (and tests/dictation-typing.mjs checks):
//  - Typing, backspacing or deleting never stops dictation. It only moves the point where dictated words go.
//  - Dictated words are only ever added. They never replace or remove text the user typed or kept.
//  - The grey "still being heard" words (the tail of the box) belong to the speech engine: an edit that touches only
//    them is applied to the committed text and the tail stays put until the engine finishes it.
//  - Typing INSIDE, right after, or past the heard words freezes them: they become ordinary text exactly as shown (so
//    nothing the user sees moves or is duplicated), dictation continues right after what the user typed, and the
//    engine's continuation of that same utterance only adds the words it hears after the frozen ones (planEdit, applyCut).

export interface TextRange { start: number; end: number }
/** One manual edit, in committed-text coordinates: `removed` characters at `at` became `added` characters. */
export interface TextEdit { at: number; removed: number; added: number }

/** Add dictated words after `before`. Keeps whatever whitespace the user left at the end (a typed newline stays one). */
export function appendDictation(before: string, words: string) {
  const trimmed = words.trim();
  if (!trimmed) return before;
  if (!before.trim()) return before + trimmed[0].toUpperCase() + trimmed.slice(1);
  return before + (/\s$/.test(before) ? '' : ' ') + trimmed;
}

/** What the box shows after the committed text while words are still being heard (the engine's part of the box). */
export const dictationTail = (text: string, heard: string) => appendDictation(text, heard).slice(text.length);

/**
 * Where the words still being heard are drawn: `tail` sits inside the committed text at `at` (the dictation anchor,
 * or the end of the text when there is none) and `end` is the caret position right after the heard words.
 */
export interface LiveSpan { at: number; end: number; tail: string }

/** The live (interim) span for `text`: heard words inserted at the anchor, spaced and capitalised like the final insert. */
export function liveSpan(text: string, heard: string, anchor?: number): LiveSpan {
  const at = Math.max(0, Math.min(anchor ?? text.length, text.length));
  const words = heard.trim();
  if (!words) return { at, end: at, tail: '' };
  const before = text.slice(0, at);
  const after = text.slice(at);
  const pre = before && !/\s$/.test(before) ? ' ' : '';
  const post = after && !/^\s/.test(after) ? ' ' : '';
  const said = !before.trim() ? words[0].toUpperCase() + words.slice(1) : words;
  return { at, end: at + pre.length + said.length, tail: pre + said + post };
}

/** The text the textarea holds: the committed text with the live span spliced in at its anchor. */
export const withSpan = (text: string, span: LiveSpan) => text.slice(0, span.at) + span.tail + text.slice(span.at);

/**
 * Turn what the user did to the box into a new committed text. `shown` is the committed text with `tail` spliced in
 * at `at` (the end by default); `value` is what the textarea holds now. Edits inside the committed text are kept
 * exactly; the tail is never absorbed.
 */
export function reconcileEdit(text: string, tail: string, value: string, at = text.length): TextEdit & { text: string } {
  const position = Math.max(0, Math.min(at, text.length));
  const shown = text.slice(0, position) + tail + text.slice(position);
  if (value === shown) return { text, at: position, removed: 0, added: 0 };
  if (!tail) return { text: value, ...diff(text, value) };
  let prefix = 0;
  const limit = Math.min(shown.length, value.length);
  while (prefix < limit && shown[prefix] === value[prefix]) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && shown[shown.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
  const oldEnd = shown.length - suffix;
  const inserted = value.slice(prefix, value.length - suffix);
  // The whole edit is before the tail: committed and shown coordinates agree.
  if (oldEnd <= position) {
    return { text: text.slice(0, prefix) + inserted + text.slice(oldEnd), at: prefix, removed: oldEnd - prefix, added: inserted.length };
  }
  // The whole edit is after the tail (typing right after the dictated words): shift back by the tail's length.
  if (prefix >= position + tail.length) {
    const from = prefix - tail.length;
    const to = oldEnd - tail.length;
    return { text: text.slice(0, from) + inserted + text.slice(to), at: from, removed: to - from, added: inserted.length };
  }
  // The edit reached into the tail. Keep what was typed, drop what was deleted from the committed part, and leave
  // the tail alone (deleting still-unfinished words does nothing; the engine finishes them in a moment).
  const from = Math.min(prefix, position);
  const to = Math.max(position, oldEnd - tail.length);
  return { text: text.slice(0, from) + inserted + text.slice(to), at: from, removed: to - from, added: inserted.length };
}

/** Prefix/suffix diff of two strings, as one edit. */
function diff(before: string, after: string): TextEdit {
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { at: prefix, removed: before.length - suffix - prefix, added: after.length - suffix - prefix };
}

/**
 * Move the place a finished dictation will be inserted so it follows the user's edits. A selection that was edited
 * becomes a caret: dictation then adds words without replacing text the user has since changed.
 */
export function shiftRange(range: TextRange, edit: TextEdit): TextRange {
  const after = edit.at + edit.removed;
  const move = (position: number) => position >= after ? position + edit.added - edit.removed : position <= edit.at ? position : edit.at + edit.added;
  if (range.start === range.end) {
    const caret = move(range.start);
    return { start: caret, end: caret };
  }
  const touched = edit.at < range.end && after > range.start || (edit.at > range.start && edit.at < range.end);
  if (touched) {
    const caret = move(range.end);
    return { start: caret, end: caret };
  }
  return { start: move(range.start), end: move(range.end) };
}

/** Insert a finished dictation at `range` (end of the text when absent) and say where the caret should go. */
export function insertDictated(current: string, words: string, range?: TextRange, caret?: number) {
  const start = Math.min(range?.start ?? current.length, current.length);
  const end = Math.min(range?.end ?? current.length, current.length);
  const before = current.slice(0, start);
  const after = current.slice(end);
  const pre = before && !/\s$/.test(before) ? ' ' : '';
  const post = after && !/^\s/.test(after) ? ' ' : '';
  // Match the live preview: a dictation that starts the message starts with a capital letter.
  const said = !before.trim() ? words.charAt(0).toUpperCase() + words.slice(1) : words;
  const inserted = pre + said + post;
  const value = before + inserted + after;
  // The user's caret stays where it was relative to their own text: one at the insertion point ends after the
  // dictated words, one after it moves past them, one before it does not move.
  const inside = caret === undefined || (caret >= start && caret <= end);
  const next = inside ? start + pre.length + said.length : caret > end ? caret + inserted.length - (end - start) : caret;
  return { value, caret: Math.max(0, Math.min(next, value.length)) };
}

/**
 * The user deleted part of the words still being heard (Backspace/Delete or a selection inside the grey tail).
 * `value` is what the textarea holds, `shown` what it held before the edit. Returns the [start, end) range of the
 * heard words (`heard`, trimmed) that were removed, or undefined when the edit did not delete any of them.
 */
export function deletedHeard(shown: string, value: string, span: LiveSpan, heard: string): TextRange | undefined {
  const words = heard.trim();
  if (!words || !span.tail || value.length >= shown.length) return undefined;
  const { start, end } = (({ at, removed }) => ({ start: at, end: at + removed }))(diff(shown, value));
  const lead = span.tail.length - span.tail.trimStart().length; // the space put before the words, if any
  const from = span.at + lead;
  const to = from + words.length;
  const first = Math.max(start, from);
  const last = Math.min(end, to);
  return first < last ? { start: first - from, end: last - from } : undefined;
}

/**
 * Words the user changed in an unfinished utterance. The engine's text `original` is shown as `kept` instead (words
 * the user deleted stay gone), and the first `skip` words of the engine's text were frozen into the box as typed text
 * and must not be shown or delivered a second time.
 */
export interface HeardCut { original: string; kept: string; skip?: number }

/** The words of `text` after dropping the first `count` (whitespace-separated), re-joined with single spaces. */
export function skipWords(text: string, count: number) {
  const trimmed = text.trim();
  if (count <= 0) return trimmed;
  return trimmed.split(/\s+/).filter(Boolean).slice(count).join(' ');
}

/** How many words (whitespace-separated) the heard text holds. */
export const countWords = (heard: string) => heard.trim().split(/\s+/).filter(Boolean).length;

/**
 * What to show or deliver for `text` from the engine. While the engine keeps extending the utterance the user cut
 * words from, the cut stays applied (the deleted words do not come back); a different utterance clears the cut.
 * Frozen words (`skip`) are dropped from the start of the engine's text the same way, so they are never added twice.
 */
export function applyCut(cut: HeardCut | undefined, text: string): { text: string; cut?: HeardCut } {
  if (!cut) return { text };
  const raw = skipWords(text, cut.skip ?? 0);
  if (!raw.startsWith(cut.original)) return cut.skip ? { text: raw, cut: { original: '', kept: '', skip: cut.skip } } : { text };
  return { text: (cut.kept + raw.slice(cut.original.length)).trim(), cut };
}

/** Freeze the heard words (shown as `shown`): the cut that keeps them from being added a second time. */
export function freezeCut(cut: HeardCut | undefined, shown: string): HeardCut {
  return { original: cut?.original ?? '', kept: cut?.kept ?? '', skip: (cut?.skip ?? 0) + countWords(shown) };
}

/** The edit as the textarea reports it, aligned to where the caret says it happened (a space typed next to a space is ambiguous otherwise). */
function alignedEdit(before: string, after: string, caret?: number): TextEdit {
  const found = diff(before, after);
  if (caret === undefined) return found;
  const at = caret - found.added;
  if (at < 0 || at + found.removed > before.length) return found;
  const same = before.slice(0, at) + after.slice(at, at + found.added) + before.slice(at + found.removed) === after;
  return same ? { at, removed: found.removed, added: found.added } : found;
}

/** What a manual edit does to the box while words are being heard. */
export interface EditPlan {
  /** The committed text after the edit. */
  text: string;
  /** The edit in committed-text coordinates (moves the dictation anchor when nothing was frozen). */
  edit: TextEdit;
  /** Set when the heard words were frozen into `text`: dictation continues at `anchor` (after the typing, or after the frozen words) and skips `words` heard words. */
  freeze?: { anchor: number; words: number };
}

/**
 * Turn what the user did to the textarea (`value`, with the caret after the edit) into a new committed text.
 *  - Before the heard words, or any deletion: the edit goes into the committed text and the heard words stay (reconcileEdit).
 *  - Typing or pasting inside, directly after, or past the heard words: the box is kept exactly as the user sees it,
 *    the heard words become real text, and dictation carries on right after what was typed.
 */
export function planEdit(text: string, span: LiveSpan, heard: string, value: string, caret?: number): EditPlan {
  const tail = span.tail;
  const reconciled = (): EditPlan => { const { text: next, ...edit } = reconcileEdit(text, tail, value, span.at); return { text: next, edit }; };
  if (!tail) return reconciled();
  const made = alignedEdit(withSpan(text, span), value, caret);
  if (made.at + made.removed <= span.at || made.added === 0) return reconciled();
  // Typed after the words: dictation follows the typing. Typed inside them: it carries on after the frozen words, so the
  // sentence stays in the order it was spoken.
  const tailEnd = span.at + tail.length;
  const anchor = Math.max(0, Math.min(made.at >= tailEnd ? caret ?? made.at + made.added : tailEnd + made.added - made.removed, value.length));
  return { text: value, edit: made, freeze: { anchor, words: countWords(heard) } };
}

/** The caret is inside the heard words (not at either end): the user moved into them, so they should be frozen where they are. */
export function caretInsideHeard(span: LiveSpan, heard: string, caret: number) {
  const words = heard.trim();
  if (!words || !span.tail) return false;
  const from = span.at + (span.tail.length - span.tail.trimStart().length);
  return caret > from && caret < from + words.length;
}

/**
 * Where the caret goes when the words being heard change under it. A caret at the end of the words (or at the point
 * where dictation began, when nothing was heard yet) follows them; one before them stays put (the user is typing at
 * the insertion point); one after them moves with the text; one in the middle keeps its place.
 */
export function placeCaret(caret: number, previous: { at: number; len: number }, span: LiveSpan) {
  const end = previous.at + previous.len;
  if (caret > end) return caret + span.tail.length - previous.len;
  if (caret === previous.at && previous.len > 0) return caret;
  if (caret >= previous.at && caret < end) return Math.min(caret, span.end);
  if (caret === end) return span.end;
  return caret;
}
