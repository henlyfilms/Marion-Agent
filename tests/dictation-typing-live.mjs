// Typing, pasting, deleting and moving the caret WHILE dictation is running. A tiny model of the chat box (the same pure
// helpers the Composer and the dictation host call) is driven through realistic sessions, checking that nothing the user
// typed is lost, moved or duplicated, dictated words are never added twice, and the caret stays where the user is.
// Usage: node tests/dictation-typing-live.mjs
import assert from 'node:assert/strict';
import { applyCut, caretInsideHeard, deletedHeard, freezeCut, insertDictated, liveSpan, placeCaret, planEdit, shiftRange, skipWords, withSpan } from '../web/src/voice/dictationText.ts';

/** The box + dictation host, as wired in Composer.tsx and composerDictation.tsx. */
function box(text = '', anchor) {
  const m = {
    text, anchor, raw: '', cut: undefined, caret: undefined,
    heard() { return applyCut(m.cut, m.raw).text; },
    span() { return liveSpan(m.text, m.heard(), m.anchor); },
    shown() { return withSpan(m.text, m.span()); },
    /** The speech engine reports the unfinished words. */
    hear(raw) { m.raw = raw; m.cut = applyCut(m.cut, raw).cut; return m; },
    /** The engine finalises `words` (the whole utterance): delivered at the anchor, then the box moves on. */
    final(words) {
      const delivered = applyCut(m.cut, words).text;
      m.cut = undefined; m.raw = '';
      if (!delivered.trim()) return m;
      const placed = insertDictated(m.text, delivered, m.anchor === undefined ? undefined : { start: m.anchor, end: m.anchor });
      m.text = placed.value;
      if (m.anchor !== undefined) m.anchor = placed.caret;
      return m;
    },
    /** The user edits the textarea: `value` is what it holds now, `caret` where the caret is. */
    edit(value, caret) {
      const span = m.span();
      const heard = m.heard();
      const plan = planEdit(m.text, span, heard, value, caret);
      if (plan.freeze) {
        m.cut = freezeCut(m.cut, heard);
        m.anchor = plan.freeze.anchor;
      } else {
        if (m.anchor !== undefined) { const r = shiftRange({ start: m.anchor, end: m.anchor }, plan.edit); m.anchor = r.end; }
        const cutRange = deletedHeard(m.shown(), value, span, heard);
        if (cutRange) {
          const kept = (heard.slice(0, cutRange.start) + heard.slice(cutRange.end)).trim();
          m.cut = { original: skipWords(m.raw, m.cut?.skip ?? 0), kept, skip: m.cut?.skip };
        }
      }
      m.text = plan.text;
      return m;
    },
    /** Type `chars` with the caret at `at` of what is shown. */
    type(at, chars) {
      const shown = m.shown();
      return m.edit(shown.slice(0, at) + chars + shown.slice(at), at + chars.length);
    },
    /** Backspace `count` characters before `at` of what is shown. */
    backspace(at, count = 1) {
      const shown = m.shown();
      return m.edit(shown.slice(0, at - count) + shown.slice(at), at - count);
    },
  };
  return m;
}

// ---- typing BEFORE the heard words: the words stay, the typed text stays, dictation lands after both ----
{
  const m = box('Hello', 5).hear('this is dictation');
  assert.equal(m.shown(), 'Hello this is dictation');
  m.type(0, 'Oh, '); // caret at the very start
  assert.equal(m.shown(), 'Oh, Hello this is dictation', 'typing before the words must not move them');
  assert.equal(m.anchor, 9, 'the dictation anchor follows the text it sat after');
  m.final('this is dictation');
  assert.equal(m.text, 'Oh, Hello this is dictation');
  m.hear('and more').final('and more');
  assert.equal(m.text, 'Oh, Hello this is dictation and more');
}
console.log('PASS: typing before the heard words shifts the anchor; nothing is overwritten or duplicated.');

// ---- typing AT THE END of the heard words: they freeze, the typed text follows them, dictation continues after it ----
{
  const m = box('', undefined).hear('hello there');
  assert.equal(m.shown(), 'Hello there');
  m.type(11, '!'); // caret right after the heard words
  assert.equal(m.shown(), 'Hello there!', 'typed text must stay AFTER the words it was typed after');
  assert.equal(m.text, 'Hello there!');
  assert.equal(m.heard(), '', 'frozen words are no longer shown as heard');
  // The engine keeps extending the same utterance: only the new words appear, once.
  m.hear('hello there how are you');
  assert.equal(m.heard(), 'how are you');
  assert.equal(m.shown(), 'Hello there! how are you');
  m.final('hello there how are you today');
  assert.equal(m.text, 'Hello there! how are you today', 'the frozen words are not delivered a second time');
}
console.log('PASS: typing after the heard words freezes them, keeps the typed text in place and never duplicates words.');

// ---- typing INSIDE the heard words ----
{
  const m = box('Note:', 5).hear('buy milk and eggs');
  assert.equal(m.shown(), 'Note: buy milk and eggs');
  m.type(14, 'X'); // inside "milk and"... after "Note: buy milk"
  assert.equal(m.shown(), 'Note: buy milkX and eggs', 'a character typed inside the words stays exactly where it was typed');
  assert.equal(m.text, 'Note: buy milkX and eggs');
  assert.equal(m.anchor, 24, 'dictation continues after the frozen words, so the sentence stays in spoken order');
  m.hear('buy milk and eggs plus bread');
  assert.equal(m.shown(), 'Note: buy milkX and eggs plus bread');
  m.final('buy milk and eggs plus bread');
  assert.equal(m.text, 'Note: buy milkX and eggs plus bread', 'nothing duplicated or lost');
}
console.log('PASS: typing inside the heard words keeps every character where it was typed.');

// ---- a pasted block and a replaced selection ----
{
  const m = box('', undefined).hear('first part');
  m.type(10, ' PASTED TEXT');
  assert.equal(m.shown(), 'First part PASTED TEXT');
  m.hear('first part and then more');
  assert.equal(m.shown(), 'First part PASTED TEXT and then more');
  // Select everything and type over it: the heard words go with the selection and do not come back.
  const n = box('', undefined).hear('old words');
  n.edit('New', 3);
  assert.equal(n.shown(), 'New');
  n.hear('old words fresh speech');
  assert.equal(n.shown(), 'New fresh speech');
}
console.log('PASS: pasting after the words and replacing the whole box keep the typed text and never re-add replaced words.');

// ---- deleting heard words (the Backspace-into-interim fix) still removes them for good and keeps dictating ----
{
  const m = box('First words', undefined).hear('and still being heard');
  assert.equal(m.shown(), 'First words and still being heard');
  m.backspace(m.shown().length, 6); // Backspace over " heard"
  assert.equal(m.shown(), 'First words and still being');
  assert.equal(m.text, 'First words', 'the committed text is untouched');
  m.hear('and still being heard now');
  assert.equal(m.shown(), 'First words and still being now', 'the deleted word stays deleted');
  // Backspace across the boundary into committed text deletes there and cuts the heard words, and nothing is duplicated.
  const k = box('Hi there', undefined).hear('you all');
  k.backspace(9, 2); // deletes the last committed letter and the space before the heard words
  assert.equal(k.text, 'Hi ther', 'committed text loses the backspaced characters');
}
console.log('PASS: deleting heard words and backspacing into committed text still work.');

// ---- Backspace after a freeze deletes the user's text, not dictation, and later speech still appends ----
{
  const m = box('', undefined).hear('good morning');
  m.type(12, 'xyz');
  m.backspace(m.shown().length, 2);
  assert.equal(m.shown(), 'Good morningx');
  m.hear('good morning team').final('good morning team');
  assert.equal(m.text, 'Good morningx team');
}
console.log('PASS: backspacing typed text after a freeze is plain editing and later speech appends cleanly.');

// ---- typing elsewhere (before) while words are still arriving: repeated updates never disturb the typed text ----
{
  const m = box('Dear team,', 10).hear('thanks');
  let typed = '';
  for (const ch of ' I wrote this') {
    m.type(10 + typed.length, ch); // user types at the insertion point, each key between engine updates
    typed += ch;
    m.hear(m.raw + ' more'); // the engine grows the interim between keystrokes
  }
  assert.ok(m.text.startsWith('Dear team, I wrote this'), `typed text must stay intact, got "${m.text}"`);
  assert.equal(m.text.split('thanks').length, 1, 'heard words are not in the committed text yet');
  assert.ok(m.shown().startsWith('Dear team, I wrote this thanks'), 'heard words stay after what the user typed');
}
console.log('PASS: typing at the dictation point while words keep arriving keeps both in order.');

// ---- a space typed next to a space is aligned to the caret, not to the first matching character ----
{
  const m = box('Hi', 2).hear('there');
  assert.equal(m.shown(), 'Hi there');
  m.type(2, ' '); // caret before the separating space
  assert.equal(m.text, 'Hi ', 'the space goes before the words, not inside them');
  assert.equal(m.shown(), 'Hi there', 'the typed space replaces the separator instead of doubling it');
  assert.ok(!planEdit('Hi', liveSpan('Hi', 'there', 2), 'there', 'Hi  there', 3).freeze, 'typing at the insertion point never freezes');
}
console.log('PASS: typing at the insertion point is not mistaken for typing inside the words.');

// ---- caret following ----
{
  const span = (text, heard, anchor) => liveSpan(text, heard, anchor);
  // Caret at the end of the words follows them as they grow.
  let before = { at: 5, len: 6 }; // " hello"
  assert.equal(placeCaret(11, before, span('Hello', 'hello world', 5)), span('Hello', 'hello world', 5).end);
  // A caret before the words (typing at the insertion point) stays put even though words are streaming in.
  assert.equal(placeCaret(5, before, span('Hello', 'hello world', 5)), 5);
  // A caret after them moves with the text.
  const grown = span('Hello', 'hello world and more', 5);
  assert.equal(placeCaret(20, before, grown), 20 + grown.tail.length - before.len);
  // No words yet: the caret at the insertion point follows the first words in.
  assert.equal(placeCaret(5, { at: 5, len: 0 }, span('Hello', 'hi', 5)), span('Hello', 'hi', 5).end);
  // A caret before the insertion point never moves.
  assert.equal(placeCaret(2, before, span('Hello', 'hello world', 5)), 2);
}
console.log('PASS: the caret follows the heard words only when it was at their end; it never jumps back or to the end otherwise.');

// ---- moving the caret into the heard words freezes them in place ----
{
  const text = 'Note:';
  const s = liveSpan(text, 'buy milk', 5);
  const shown = withSpan(text, s); // "Note: buy milk"
  assert.equal(shown, 'Note: buy milk');
  assert.equal(caretInsideHeard(s, 'buy milk', 9), true, 'caret between the words is inside');
  assert.equal(caretInsideHeard(s, 'buy milk', 6), false, 'caret at the start of the words is not');
  assert.equal(caretInsideHeard(s, 'buy milk', shown.length), false, 'caret at the end of the words is not');
  assert.equal(caretInsideHeard(s, 'buy milk', 2), false, 'caret in the committed text is not');
  assert.equal(caretInsideHeard(liveSpan('x', '', 1), '', 1), false);
}
console.log('PASS: only a caret strictly inside the heard words freezes them.');

// ---- freezing twice and combining with deletions ----
{
  const cut1 = freezeCut(undefined, 'one two');
  assert.deepEqual(cut1, { original: '', kept: '', skip: 2 });
  assert.equal(applyCut(cut1, 'one two three').text, 'three');
  assert.equal(applyCut(cut1, 'one two').text, '');
  const cut2 = freezeCut(cut1, 'three four');
  assert.equal(applyCut(cut2, 'one two three four five').text, 'five');
  // The engine revising a frozen word does not bring words back or duplicate them.
  assert.equal(applyCut(freezeCut(undefined, 'wor'), 'world peace').text, 'peace');
  // Frozen words and a user deletion together.
  const both = { original: 'c d', kept: 'c', skip: 2 };
  assert.equal(applyCut(both, 'a b c d e').text, 'c e');
}
console.log('PASS: frozen words are skipped once, repeatedly, and together with deletions.');
