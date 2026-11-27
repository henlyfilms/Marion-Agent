// "@" bot mentions in the chat composer: the picker opens only at the start or after whitespace (never inside an email
// address), filters the team's Bots by name and job as you type, inserts "@Name " at the caret, and sent messages mark
// the mentions. Pure logic from web/src/lib/mentions.ts plus source checks that the Composer wires it like the "/" picker
// (same popover, ArrowUp/ArrowDown/Enter/Tab/Escape, mouse pick, narrow-window rules).
// Usage: node --import tsx tests/mention-picker.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const M = await import('../web/src/lib/mentions.ts');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ---------- when the picker opens ----------
assert.deepEqual(M.mentionAt('@', 1), { start: 0, end: 1, query: '' }, 'at the very start');
assert.deepEqual(M.mentionAt('hey @qu', 7), { start: 4, end: 7, query: 'qu' }, 'after a space');
assert.deepEqual(M.mentionAt('line one\n@ar', 12), { start: 9, end: 12, query: 'ar' }, 'after a newline');
assert.equal(M.mentionAt('mail a@b.com', 12), null, 'never inside an email address');
assert.equal(M.mentionAt('foo@bar', 7), null, 'never inside a word');
assert.equal(M.mentionAt('hey @ there', 6), null, 'a space right after @ closes it');
assert.equal(M.mentionAt('@qu', 0), null, 'caret before the @');
assert.equal(M.mentionAt('@qu', null), null, 'no caret (box not focused)');
assert.deepEqual(M.mentionAt('@code rev', 9), { start: 0, end: 9, query: 'code rev' }, 'names with spaces can be typed out');
assert.equal(M.mentionAt('@code  rev', 10), null, 'two spaces end it');
assert.deepEqual(M.mentionAt('@qu and more', 3), { start: 0, end: 3, query: 'qu' }, 'only what is before the caret counts');

// ---------- filtering ----------
const bots = [
  { id: 'q', name: 'Quinn', label: 'Research' },
  { id: 'c', name: 'Code Reviewer', label: 'Engineering' },
  { id: 'a', name: 'Ari', label: 'Designer' },
  { id: 'r', name: 'Rex', label: 'Release manager' },
  { id: 'z', name: 'Zoë', label: '' },
];
const names = (query, options) => M.matchMentionBots(bots, query, options).map((b) => b.name);
assert.deepEqual(names(''), ['Ari', 'Code Reviewer', 'Quinn', 'Rex', 'Zoë'], 'bare @ lists everyone, alphabetically');
assert.deepEqual(names('qu'), ['Quinn'], 'name prefix');
assert.deepEqual(names('QU'), ['Quinn'], 'case-insensitive');
assert.deepEqual(names('rev'), ['Code Reviewer'], 'a later word of the name');
assert.deepEqual(names('re'), ['Rex', 'Code Reviewer', 'Quinn'], 'name prefix, then word prefix, then job');
assert.deepEqual(names('design'), ['Ari'], 'by job (label)');
assert.deepEqual(names('zoe'), ['Zoë'], 'accents fold');
assert.deepEqual(names('code rev'), ['Code Reviewer'], 'typed-out names with spaces');
assert.deepEqual(names('nobody'), [], 'no match closes the picker');
assert.deepEqual(names('Quinn '), [], 'closes once a full name is followed by a space (just picked)');
assert.deepEqual(names('', { prefer: new Set(['r']) })[0], 'Rex', 'group members first');
assert.equal(M.matchMentionBots(Array.from({ length: 20 }, (_, i) => ({ id: `${i}`, name: `Bot ${i}` })), '').length, 8, 'at most 8 rows');

// ---------- inserting ----------
assert.deepEqual(M.insertMention('@qu', { start: 0, end: 3 }, 'Quinn'), { text: '@Quinn ', caret: 7 });
assert.deepEqual(M.insertMention('ask @co please', { start: 4, end: 7 }, 'Code Reviewer'), { text: 'ask @Code Reviewer please', caret: 19 }, 'no double space; caret after it');
assert.deepEqual(M.insertMention('hi @', { start: 3, end: 4 }, 'Ari'), { text: 'hi @Ari ', caret: 8 });
const picked = M.insertMention('@qu', { start: 0, end: 3 }, 'Quinn');
assert.deepEqual(M.matchMentionBots(bots, M.mentionAt(picked.text, picked.caret).query), [], 'after a pick the picker is closed');
assert.deepEqual(M.matchMentionBots(bots, M.mentionAt(picked.text + 'can you', picked.caret + 7).query), [], 'and stays closed as the message goes on');

// ---------- sent messages ----------
assert.deepEqual(M.mentionSegments('@Quinn and @Code Reviewer, look', ['Quinn', 'Code Reviewer']),
  [{ text: '@Quinn', mention: true }, { text: ' and ' }, { text: '@Code Reviewer', mention: true }, { text: ', look' }]);
assert.deepEqual(M.mentionSegments('mail quinn@example.com', ['Quinn']), [{ text: 'mail quinn@example.com' }], 'emails are not mentions');
assert.deepEqual(M.mentionSegments('@Quinnie hi', ['Quinn']), [{ text: '@Quinnie hi' }], 'only whole names');
assert.deepEqual(M.mentionSegments('@quinn hi', ['Quinn']).map((p) => p.mention ?? false), [true, false], 'case-insensitive like the server');
assert.equal(M.mentionSegments('hello', ['Quinn']).map((p) => p.text).join(''), 'hello');

// ---------- Composer wiring (same popover and keys as the "/" picker) ----------
const composer = read('web/src/components/Composer.tsx');
assert.match(composer, /import \{ insertMention, matchMentionBots, mentionAt \} from '\.\.\/lib\/mentions'/);
assert.match(composer, /className="slash-menu mention-menu" id=\{`\$\{inputId\}-mentions`\} role="listbox" aria-label="Mention a Bot"/, 'same popover as /');
const keys = composer.slice(composer.indexOf('if (mentionOpen && !e.nativeEvent.isComposing)'), composer.indexOf('if (slashOpen && !e.nativeEvent.isComposing)'));
for (const key of ["'ArrowDown'", "'ArrowUp'", "'Enter'", "'Tab'", "'Escape'"]) assert.ok(keys.includes(key), `handles ${key}`);
assert.match(keys, /pickMention\(mentionMatches\[mentionActive\]\)/, 'Enter/Tab picks');
assert.match(composer, /onMouseDown=\{event => event\.preventDefault\(\)\} onMouseEnter=\{\(\) => setMentionIndex\(index\)\} onClick=\{\(\) => pickMention\(other\)\}/, 'mouse hover and click like /');
assert.match(composer, /other\.kind !== 'room' && other\.id !== bot\.id/, 'Bots only (no group chats, not this bot)');
assert.match(composer, /api\.roomMembers\(bot\.id\)/, 'group chats offer their members');
assert.match(composer, /slashQuery === null \? mentionAt\(shown, caret\)/, 'never competes with / commands');
assert.match(composer, /aria-activedescendant=\{mentionOpen \?/, 'accessible active option');
const css = read('web/src/styles/chat.css');
assert.match(css, /\.mention-menu \.slash-menu__label/);
assert.match(css, /@media \(max-width: 630px\)[\s\S]*\.mention-menu \.slash-menu__item \{ grid-template-columns: 22px minmax\(0, 1fr\); \}/, 'narrow windows');
assert.match(read('web/src/components/Transcript.tsx'), /<MentionText text=\{b\.text\} \/>/, 'sent messages mark mentions');

console.log('PASS @ mention picker: trigger rules, filtering, insertion, rendering, Composer wiring');
