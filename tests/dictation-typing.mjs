// Typing, backspacing and deleting while dictation is running: edits are kept, dictated words only get added,
// and the place a finished dictation lands follows the user's edits.
// Usage: node tests/dictation-typing.mjs
import assert from 'node:assert/strict';
import { appendDictation, applyCut, deletedHeard, dictationTail, insertDictated, liveSpan, reconcileEdit, shiftRange, withSpan } from '../web/src/voice/dictationText.ts';

// Words keep the whitespace the user typed (a typed newline is not swallowed).
assert.equal(appendDictation('', 'hello there'), 'Hello there');
assert.equal(appendDictation('Hi', ' there '), 'Hi there');
assert.equal(appendDictation('Hi\n', 'there'), 'Hi\nthere');
assert.equal(appendDictation('Hi ', 'there'), 'Hi there');
assert.equal(appendDictation('Hi', '   '), 'Hi');
console.log('PASS: dictated words join the text without eating typed whitespace.');

// Live preview: the box shows committed text plus the words still being heard.
const preview = (text, heard) => text + dictationTail(text, heard);
{
  const text = 'Meet me at';
  const heard = 'noon tomorrow';
  const shown = preview(text, heard);
  const tail = dictationTail(text, heard);
  assert.equal(shown, 'Meet me at noon tomorrow');
  // Typing in the middle of the committed text keeps the heard words in the tail.
  let edit = reconcileEdit(text, tail, 'Meet me right at noon tomorrow');
  assert.equal(edit.text, 'Meet me right at');
  assert.deepEqual([edit.at, edit.removed, edit.added], [8, 0, 6]);
  // Backspacing inside the committed text.
  edit = reconcileEdit(text, tail, 'Meet me a noon tomorrow');
  assert.equal(edit.text, 'Meet me a');
  // Deleting the whole committed text leaves only what is still being heard.
  edit = reconcileEdit(text, tail, ' noon tomorrow');
  assert.equal(edit.text, '');
  // Typing at the very end (after the heard words) is appended to the committed text, never lost.
  edit = reconcileEdit(text, tail, shown + '!');
  assert.equal(edit.text, 'Meet me at!');
  // Backspacing into the heard words does not delete committed text and does not stop anything.
  edit = reconcileEdit(text, tail, shown.slice(0, -1));
  assert.equal(edit.text, text);
  assert.deepEqual([edit.removed, edit.added], [0, 0]);
  // Select-all and type: the committed text is replaced; the heard words are not duplicated into it.
  edit = reconcileEdit(text, tail, 'Hello');
  assert.equal(edit.text, 'Hello');
  // No change at all.
  edit = reconcileEdit(text, tail, shown);
  assert.equal(edit.text, text);
  // No words being heard: a plain edit.
  edit = reconcileEdit('abc', '', 'abXc');
  assert.deepEqual([edit.text, edit.at, edit.removed, edit.added], ['abXc', 2, 0, 1]);
}
console.log('PASS: manual edits go into the text; words still being heard are never absorbed or duplicated.');

// The insertion point for a recorded dictation follows edits made while recording.
{
  let range = { start: 5, end: 5 };
  // User types 3 characters before the insertion point.
  range = shiftRange(range, { at: 0, removed: 0, added: 3 });
  assert.deepEqual(range, { start: 8, end: 8 });
  // User deletes 2 characters before it.
  range = shiftRange(range, { at: 2, removed: 2, added: 0 });
  assert.deepEqual(range, { start: 6, end: 6 });
  // User types at the insertion point: the dictation lands after what they typed.
  range = shiftRange(range, { at: 6, removed: 0, added: 4 });
  assert.deepEqual(range, { start: 10, end: 10 });
  // Edits after it do not move it.
  range = shiftRange(range, { at: 20, removed: 0, added: 4 });
  assert.deepEqual(range, { start: 10, end: 10 });
  // A selection the user did not touch moves with the text; one they edited becomes a caret (nothing is overwritten).
  assert.deepEqual(shiftRange({ start: 10, end: 14 }, { at: 0, removed: 0, added: 2 }), { start: 12, end: 16 });
  assert.deepEqual(shiftRange({ start: 10, end: 14 }, { at: 11, removed: 1, added: 1 }), { start: 14, end: 14 });
  assert.deepEqual(shiftRange({ start: 10, end: 14 }, { at: 12, removed: 0, added: 1 }), { start: 15, end: 15 });
}
console.log('PASS: the dictation insertion point follows typing and deleting.');

// Inserting a finished dictation merges with what is there and keeps the user's caret sensible.
{
  assert.deepEqual(insertDictated('', 'hello there'), { value: 'Hello there', caret: 11 });
  assert.equal(insertDictated('Hi.', 'how are you', { start: 3, end: 3 }).value, 'Hi. how are you');
  assert.equal(insertDictated('ab', 'X', { start: 1, end: 1 }).value, 'a X b');
  // Range beyond the (shorter) text is clamped, never throws or drops text.
  assert.equal(insertDictated('ab', 'cd', { start: 50, end: 60 }).value, 'ab cd');
  // User caret later in the text moves past the dictated words; one earlier stays put.
  const later = insertDictated('one two', 'mid', { start: 3, end: 3 }, 7);
  assert.equal(later.value, 'one mid two');
  assert.equal(later.caret, 11);
  assert.equal(insertDictated('one two', 'mid', { start: 3, end: 3 }, 1).caret, 1);
}
console.log('PASS: finished dictation merges into edited text.');

// Cursor placed BEFORE existing text: the live (interim) words are drawn at the cursor, not at the end of the box.
{
  const text = 'world is big';
  // No anchor: the live words follow the end of the text (unchanged behaviour).
  assert.equal(withSpan(text, liveSpan(text, 'hello')), 'world is big hello');
  // Anchor 0 (cursor before everything): the words show first, capitalised, with a space before the old text.
  let span = liveSpan(text, 'hello there', 0);
  assert.equal(withSpan(text, span), 'Hello there world is big');
  assert.deepEqual([span.at, span.end, span.tail], [0, 11, 'Hello there ']);
  // The live preview is exactly what the finished dictation produces, so nothing jumps when it is finalised.
  assert.equal(withSpan(text, span), insertDictated(text, 'hello there', { start: 0, end: 0 }).value);
  // Cursor in the middle of the text: spaced on both sides, no capital letter.
  span = liveSpan(text, 'really', 8);
  assert.equal(withSpan(text, span), 'world is really big');
  assert.equal(withSpan(text, span), insertDictated(text, 'really', { start: 8, end: 8 }).value);
  // The caret goes right after the live words.
  assert.equal(withSpan(text, span).slice(0, span.end), 'world is really');
  // Whitespace the user already typed is reused, not doubled.
  assert.equal(withSpan('one\n two', liveSpan('one\n two', 'mid', 4)), 'one\nmid two');
  assert.equal(liveSpan('one two', 'mid', 3).tail, ' mid');
  assert.equal(liveSpan('one two', '   ', 3).tail, '');
  // An anchor beyond the text is clamped to the end.
  assert.equal(withSpan('ab', liveSpan('ab', 'cd', 99)), 'ab cd');

  // Typing while the interim words are displayed at the cursor never absorbs them and never stops dictation.
  const heard = 'hello there';
  span = liveSpan(text, heard, 0);
  const shown = withSpan(text, span); // 'Hello there world is big'
  // Typing right after the live words (where the caret sits): lands in the committed text at the anchor.
  let edit = reconcileEdit(text, span.tail, shown.slice(0, span.end) + 'X' + shown.slice(span.end), span.at);
  assert.equal(edit.text, 'Xworld is big');
  assert.deepEqual([edit.at, edit.removed, edit.added], [0, 0, 1]);
  // The anchor then moves after what was typed, so dictation continues after it.
  assert.deepEqual(shiftRange({ start: 0, end: 0 }, edit), { start: 1, end: 1 });
  // Typing after the old text (past the live words) is shifted back into committed coordinates.
  edit = reconcileEdit(text, span.tail, shown + '!', span.at);
  assert.equal(edit.text, 'world is big!');
  assert.deepEqual(shiftRange({ start: 0, end: 0 }, edit), { start: 0, end: 0 });
  // Typing in the old text after the live words leaves the anchor where it was.
  edit = reconcileEdit(text, span.tail, shown.replace('is', 'was'), span.at);
  assert.equal(edit.text, 'world was big');
  assert.deepEqual([edit.at, edit.removed, edit.added], [6, 1, 2]);
  // Deleting old text after the live words (backspace in the old text).
  edit = reconcileEdit(text, span.tail, shown.replace(' is', ''), span.at);
  assert.equal(edit.text, 'world big');
  // Backspacing into the live words does not delete committed text and does not move the anchor.
  edit = reconcileEdit(text, span.tail, shown.slice(0, span.end - 1) + shown.slice(span.end), span.at);
  assert.equal(edit.text, text);
  assert.deepEqual([edit.removed, edit.added], [0, 0]);
  // Select-all and type replaces the committed text; the live words are not copied into it.
  edit = reconcileEdit(text, span.tail, 'Yo', span.at);
  assert.equal(edit.text, 'Yo');
  // Edits with the span in the middle of the text.
  const middle = liveSpan(text, 'really', 8);
  const shownMiddle = withSpan(text, middle); // 'world is really big'
  edit = reconcileEdit(text, middle.tail, shownMiddle.replace('world', 'hello'), middle.at);
  assert.equal(edit.text, 'hello is big');
  edit = reconcileEdit(text, middle.tail, shownMiddle.replace('big', 'bigger'), middle.at);
  assert.equal(edit.text, 'world is bigger');
  // No edit at all.
  edit = reconcileEdit(text, middle.tail, shownMiddle, middle.at);
  assert.deepEqual([edit.text, edit.removed, edit.added], [text, 0, 0]);

  // A dictation that began before the old text, finalised: the words land at the (shifted) anchor.
  const typed = reconcileEdit(text, span.tail, 'Oh ' + shown, span.at); // typed at the very start of the box
  assert.equal(typed.text, 'Oh world is big');
  const anchor = shiftRange({ start: 0, end: 0 }, typed);
  assert.deepEqual(anchor, { start: 3, end: 3 });
  assert.equal(insertDictated(typed.text, heard, anchor).value, 'Oh hello there world is big');
}
console.log('PASS: live dictation text appears at the cursor (before existing text), and typing/deleting around it never stops dictation.');

// Deleting words that are still being heard removes them for good while the engine keeps extending the utterance.
{
  const span = liveSpan('First words', 'and still being heard');
  const shown = withSpan('First words', span);
  assert.equal(shown, 'First words and still being heard');
  assert.deepEqual(deletedHeard(shown, shown.slice(0, -6), span, 'and still being heard'), { start: 15, end: 21 });
  assert.equal(deletedHeard(shown, 'irst words and still being heard', span, 'and still being heard'), undefined, 'deleting committed text cuts nothing');
  const cut = { original: 'and still being heard', kept: 'and still being' };
  assert.equal(applyCut(cut, 'and still being heard now').text, 'and still being now');
  assert.equal(applyCut(cut, 'and still being heard').text, 'and still being');
  assert.equal(applyCut(cut, 'something else').cut, undefined, 'a new utterance clears the cut');
}
console.log('PASS: deleting still-being-heard words keeps them deleted.');
