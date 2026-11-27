// Chat-locked dictation: words always go to the chat dictation was started in (into its box when mounted, else into its
// saved draft), never into the chat on screen; switching chats, opening Settings or clicking any button/tab/drawer/modal
// never pauses, stops or cancels it. Pure router logic plus source checks on the host and the Composer.
// Usage: node --import tsx tests/dictation-routing.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDictationRouter } from '../web/src/voice/dictationRouting.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ---------- router: locked to the owner chat ----------
const router = createDictationRouter();
const drafts = { a: [], b: [] };
const boxA = { botId: 'a', words: [] };
const boxB = { botId: 'b', words: [] };
const send = (owner, word) => router.deliver(owner, to => to.words.push(word), botId => drafts[botId].push(word));

const removeA = router.register(boxA);
send('a', 'one');
// Switch to chat B: B's box mounts while A's is still mounted, then A's unmounts.
const removeB = router.register(boxB);
send('a', 'two');
removeA();
send('a', 'three');
send('a', 'four');
// Back to A: its box mounts again.
const removeA2 = router.register(boxA);
send('a', 'five');
assert.deepEqual(boxA.words, ['one', 'two', 'five'], 'A box gets A words while mounted');
assert.deepEqual(drafts.a, ['three', 'four'], 'A words go to A draft while A is off screen');
assert.deepEqual(boxB.words, [], 'chat B never receives chat A dictation');
assert.deepEqual(drafts.b, [], 'chat B draft is never touched');
send(undefined, 'nobody');
assert.equal(boxA.words.length + drafts.a.length, 5, 'no owner, nothing delivered');
assert.equal(router.latest(), boxA, 'latest mounted box (for errors)');
removeA2();
removeB();
assert.equal(router.latest(), undefined);
removeB(); // double removal is harmless

// Settings open with no chat box mounted at all: still goes to the owner draft.
send('b', 'from settings');
assert.deepEqual(drafts.b, ['from settings']);

// ---------- host: nothing but the user stops it ----------
const host = read('web/src/voice/composerDictation.tsx');
const hostBody = host.split('export function ComposerDictationHost')[1];
assert.doesNotMatch(hostBody, /controls\?\.commit\(\)/, 'leaving the chat / opening Settings no longer commits (stops) dictation');
assert.doesNotMatch(hostBody, /appSettings|botSettings|mobileChatOpen|useCompactLayout/, 'the host does not react to Settings, drawers or layout');
assert.doesNotMatch(hostBody, /selectedBotId !== previous\.selectedBotId/, 'switching chats does not reset the dictation anchor');
assert.match(host, /let owner: string \| undefined/, 'the host tracks the owner chat');
assert.match(host, /setOwner\(botId\)/, 'starting dictation locks it to the chat it was started in');
assert.match(host, /routing\.deliver\(target/, 'words are delivered to the owner, not the selected chat');
assert.match(host, /saveToDraft\(botId/, 'an off-screen owner gets the words in its draft');
assert.match(host, /if \(state === 'idle'\) \{[^}]*setOwner\(undefined\)/, 'the lock ends only when dictation ends');

// ---------- Composer: only the owner shows words; Esc closing Settings/modals never cancels ----------
const composer = read('web/src/components/Composer.tsx');
assert.match(composer, /s\.owner === bot\.id \? s\.interim : ''/, 'only the owner chat box shows the words being heard');
assert.match(composer, /Dictating in \$\{ownerName/, 'other chats say where dictation is going');
assert.match(composer, /event\.key === 'Escape' && state !== 'idle' && ownsDictation/, 'Esc cancels only from the owner box');
assert.match(composer, /!ui\.appSettings && !ui\.botSettings && !useStore\.getState\(\)\.modal\) discardDictation/, 'Esc that closes Settings/modals does not cancel');

console.log('PASS: dictation stays locked to its chat (box or draft), and Settings, chat switches and UI clicks never stop it.');
