import assert from 'node:assert/strict';
import {
  BLOCK_BREAK, MAX_MATCHES, clampIndex, findMatches, isBlankQuery, joinParts, locate, matchLabel, nearestIndex, stepIndex,
} from '../web/src/lib/chatSearch.ts';

// Offline check of in-chat search (Cmd/Ctrl+F): matching, mapping matches onto text nodes, wrap-around stepping and the counter.
// Usage: node tests/chat-search.mjs   (no browser, server or network)

const starts = (text, query) => findMatches(text, query).map(m => m.start);

// Case-insensitive, several matches per message, in order.
assert.deepEqual(findMatches('Hello hello HELLO', 'hello'), [{ start: 0, end: 5 }, { start: 6, end: 11 }, { start: 12, end: 17 }]);
assert.deepEqual(starts('Marion marion MARION', 'MaRiOn'), [0, 7, 14]);
assert.deepEqual(starts('ÄÖ äö', 'äö'), [0, 3], 'non-ASCII letters fold case too');
assert.deepEqual(findMatches('aaaa', 'aa'), [{ start: 0, end: 2 }, { start: 2, end: 4 }], 'matches never overlap');
console.log('PASS: matching is case-insensitive and finds every occurrence.');

// Empty query / no matches / odd input.
for (const blank of ['', ' ', '   \n']) { assert.ok(isBlankQuery(blank)); assert.deepEqual(findMatches('anything', blank), []); }
assert.deepEqual(findMatches('', 'x'), []);
assert.deepEqual(findMatches('nothing here', 'zebra'), []);
assert.deepEqual(starts('a b  c', 'b'), [2]);
console.log('PASS: empty queries and misses give no matches.');

// The query is literal text, never a pattern.
assert.deepEqual(starts('a.b axb', 'a.b'), [0]);
assert.deepEqual(starts('f(x) [y] $5 ^ \\ * + ? | { }', '(x)'), [1]);
for (const nasty of ['(', '[', '\\', '*', '+', '?', '{', '}', '$', '^', '|', '.', '(?:']) assert.doesNotThrow(() => findMatches('x (?: [ \\ * +', nasty), nasty);
assert.deepEqual(starts('x (?: y', '(?:'), [2]);
// Spaces in the query also match a soft line break from markdown.
assert.deepEqual(findMatches('hello\nworld', 'hello world'), [{ start: 0, end: 11 }]);
console.log('PASS: the query is searched as plain text.');

// Cap on matches.
assert.equal(findMatches('a'.repeat(MAX_MATCHES + 500), 'a').length, MAX_MATCHES);
assert.equal(findMatches('a'.repeat(50), 'a', 7).length, 7);
console.log('PASS: very common words stop at the cap.');

// Mapping onto rendered text nodes: "say <strong>hel</strong>lo there" is three nodes in one block.
const para = { id: 'p1' };
const joined = joinParts([{ text: 'say ', block: para }, { text: 'hel', block: para }, { text: 'lo there', block: para }]);
assert.equal(joined.text, 'say hello there');
assert.deepEqual(joined.segments, [{ start: 0, length: 4 }, { start: 4, length: 3 }, { start: 7, length: 8 }]);
const [hit] = findMatches(joined.text, 'HELLO');
assert.deepEqual(locate(joined.segments, hit.start, 'start'), { segment: 1, offset: 0 });
assert.deepEqual(locate(joined.segments, hit.end, 'end'), { segment: 2, offset: 2 }, 'a match can span inline elements');
// Edges: a match ending exactly where a node ends stays in that node; one starting there belongs to the next.
assert.deepEqual(locate(joined.segments, 4, 'end'), { segment: 0, offset: 4 });
assert.deepEqual(locate(joined.segments, 4, 'start'), { segment: 1, offset: 0 });
assert.equal(locate(joined.segments, 999, 'start'), null);
assert.equal(locate(joined.segments, 0, 'end'), null);
console.log('PASS: matches map back onto the right text nodes, including across inline formatting.');

// Blocks do not run together: end of one paragraph + start of the next is not a match.
const second = { id: 'p2' };
const twoBlocks = joinParts([{ text: 'first foo', block: para }, { text: 'bar second', block: second }]);
assert.ok(twoBlocks.text.includes(BLOCK_BREAK));
assert.deepEqual(findMatches(twoBlocks.text, 'foobar'), []);
assert.deepEqual(findMatches(twoBlocks.text, 'foo bar'), [], 'a space in the query does not bridge two blocks either');
assert.equal(findMatches(twoBlocks.text, 'bar').length, 1);
const [barHit] = findMatches(twoBlocks.text, 'bar');
assert.deepEqual(locate(twoBlocks.segments, barHit.start, 'start'), { segment: 1, offset: 0 });
assert.deepEqual(joinParts([]), { text: '', segments: [] });
console.log('PASS: paragraphs, list items and code blocks are searched separately.');

// Next / previous wrap around.
assert.equal(stepIndex(0, 3, 1), 1);
assert.equal(stepIndex(1, 3, 1), 2);
assert.equal(stepIndex(2, 3, 1), 0, 'next wraps from the last match to the first');
assert.equal(stepIndex(0, 3, -1), 2, 'previous wraps from the first match to the last');
assert.equal(stepIndex(2, 3, -1), 1);
assert.equal(stepIndex(0, 1, 1), 0);
assert.equal(stepIndex(0, 1, -1), 0);
assert.equal(stepIndex(0, 0, 1), 0);
assert.equal(stepIndex(5, 0, -1), 0);
assert.equal(stepIndex(9, 3, 1), 0, 'a stale index is pulled back in range first');
assert.equal(stepIndex(NaN, 3, 1), 1);
let at = 0;
const visited = [];
for (let i = 0; i < 7; i++) { at = stepIndex(at, 3, 1); visited.push(at); }
assert.deepEqual(visited, [1, 2, 0, 1, 2, 0, 1]);
for (let i = 0; i < 7; i++) at = stepIndex(at, 3, -1);
assert.equal(at, 0, 'seven steps forward then seven back returns to the start');
assert.equal(clampIndex(5, 3), 2); assert.equal(clampIndex(-2, 3), 0); assert.equal(clampIndex(1, 0), 0); assert.equal(clampIndex(NaN, 3), 0);
console.log('PASS: next and previous wrap around.');

// Where a new search starts, and what the counter says.
assert.equal(nearestIndex([100, 400, 900], 450), 1);
assert.equal(nearestIndex([100, 400, 900], -50), 0);
assert.equal(nearestIndex([100, 400, 900], 5000), 2);
assert.equal(nearestIndex([], 10), 0);
assert.equal(matchLabel('', 0, 0), '0 / 0');
assert.equal(matchLabel('  ', 3, 3), '0 / 0');
assert.equal(matchLabel('zebra', 0, 0), 'No matches');
assert.equal(matchLabel('a', 1, 7), '2 / 7');
assert.equal(matchLabel('a', 99, 7), '7 / 7');
console.log('PASS: a new search starts at the match nearest the view; the counter reads 2 / 7, 0 / 0 or No matches.');
