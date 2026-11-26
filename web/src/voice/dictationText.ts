// Pure text helpers that let dictation and manual typing share one message box.
//
// Rules the chat box follows (and tests/dictation-typing.mjs checks):
//  - Typing, backspacing or deleting never stops dictation. It only moves the point where dictated words go.
//  - Dictated words are only ever added. They never replace or remove text the user typed or kept.
//  - The grey "still being heard" words (the tail of the box) belong to the speech engine: an edit that touches only
//    them is applied to the committed text and the tail stays put until the engine finishes it.

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
