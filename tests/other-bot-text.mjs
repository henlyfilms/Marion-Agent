// Text from other bots gets its own bubble class and color; user and own-bot text stays normal.
// Usage: node tests/other-bot-text.mjs   (no browser, server or network)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isOtherBotMessage, senderBubbleClass } from '../web/src/lib/senderKind.ts';

const botToBot = { role: 'user', from: { kind: 'bot' } };        // server/src/agent/loop.ts: message sent to this bot by another bot
const groupReply = { role: 'assistant', from: { kind: 'bot' } }; // server/src/agent/rooms.ts: a bot's reply in a group chat
assert.equal(isOtherBotMessage(botToBot), true);
assert.equal(isOtherBotMessage(groupReply), true);
assert.equal(senderBubbleClass(botToBot), ' is-other-bot');
assert.equal(senderBubbleClass(groupReply), ' is-other-bot');
for (const normal of [
  { role: 'user' }, { role: 'assistant' },
  { role: 'user', from: { kind: 'voice' } }, { role: 'user', from: { kind: 'routine' } }, { role: 'assistant', from: { kind: 'model' } },
]) {
  assert.equal(isOtherBotMessage(normal), false, JSON.stringify(normal));
  assert.equal(senderBubbleClass(normal), '');
}

// The class is wired into the transcript and styled in both themes.
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
assert.match(read('../web/src/components/Transcript.tsx'), /senderBubbleClass\(b\)/);
assert.match(read('../web/src/styles/chat.css'), /\.is-other-bot[^{]*\{[^}]*--color-text-other-bot/);
const [light, dark] = read('../web/src/styles/tokens.css').split(":root[data-color-scheme='dark']");
assert.match(light, /--color-text-other-bot:/);
assert.match(dark, /--color-text-other-bot:/);

// Contrast on the default light surface and a typical dark surface (teal blended with the foreground).
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, pa) => a.map((v, i) => v * pa + b[i] * (1 - pa));
const lum = c => { const f = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const lightRatio = ratio(mix(hex('#0B7285'), hex('#251d29'), 0.78), hex('#faf8fa'));
assert.ok(lightRatio >= 4.5, `light contrast ${lightRatio}`);
const darkRatio = ratio(mix(hex('#4FD1E0'), hex('#f5f5f5'), 0.8), hex('#1c1c1c'));
assert.ok(darkRatio >= 4.5, `dark contrast ${darkRatio}`);
console.log('other-bot-text ok');
