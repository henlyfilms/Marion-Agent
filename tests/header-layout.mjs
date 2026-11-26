// Chat header on narrow and half-screen windows: the Bot pill, the Sessions pill and the round Search / Share / sidebar
// buttons never overlap. Renders the real stylesheets with the real header markup in Chromium at many widths.
// Usage: node tests/header-layout.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const css = ['tokens', 'base', 'shell', 'chat', 'sessions'].map(name => readFileSync(new URL(`../web/src/styles/${name}.css`, import.meta.url), 'utf8')).join('\n');
const page = (width, name, live) => `<!doctype html><meta charset="utf-8"><style>${css}</style>
<body style="margin:0"><main class="chat" style="position:relative;width:${width}px;height:240px">
<header class="chat__header">
  <button class="icon-btn sidebar-back">‹</button>
  <div class="chat__header-main">
    <span class="chat__pill-anchor"><button class="chat__pill"><span class="bot-avatar" style="width:26px;height:26px;display:inline-block"></span><span class="chat__pill-name">${name}</span></button></span>
    <button class="chat__sessions"><svg width="15" height="15"></svg><span class="chat__sessions-label">Sessions</span>${live ? '<span class="chat__sessions-live">3</span>' : ''}</button>
  </div>
</header>
<div class="conversation-actions"><button class="icon-btn">1</button><button class="icon-btn">2</button><button class="icon-btn">3</button></div>
</main>`;

// Playwright's own Chromium may be a different version than the one downloaded; fall back to any Chromium on this Mac.
const fallbacks = [
  ...['chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chromium_headless_shell-1243/chrome-headless-shell-mac-x64/chrome-headless-shell']
    .map(path => join(homedir(), 'Library/Caches/ms-playwright', path)),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(existsSync);
const browser = await chromium.launch().catch(async () => (fallbacks.length ? chromium.launch({ executablePath: fallbacks[0] }) : null)).catch(() => null);

// Always: the rules that keep the header from overlapping are in place (this part needs no browser).
const sessionsCss = readFileSync(new URL('../web/src/styles/sessions.css', import.meta.url), 'utf8');
for (const rule of [/\.chat__sessions \{[^}]*flex: 0 1 auto; min-width: 38px; overflow: hidden/, /\.chat__header \.chat__pill-anchor \{ flex: 0 1 auto; min-width: 0; \}/,
  /\.chat__header \.chat__pill-name \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/, /@media \(max-width: 1100px\) \{[^@]*\.chat__sessions-label \{ display: none; \}/]) {
  assert.match(sessionsCss, rule, `missing header rule ${rule}`);
}
assert.match(readFileSync(new URL('../web/src/components/sessions/BotSessionsPanel.tsx', import.meta.url), 'utf8'), /chat__sessions-label/);
console.log('PASS: the header shrink / truncate / compact rules are in place.');
if (!browser) { console.log('SKIP: no Chromium could start here (blocked by the sandbox), so the measured overlap check did not run.'); process.exit(0); }
const failures = [];
try {
  // Viewport 1440 with a 280px sidebar and an open details panel leaves the chat narrow even on a wide screen.
  const cases = [];
  for (const viewport of [1440, 1280, 1100]) for (const chat of [460, 560, 760]) cases.push({ viewport, chat });
  // Half-screen and narrow windows: the sidebar takes ~280px; an open details panel takes ~300px more.
  for (const viewport of [1000, 900, 800, 720, 701]) for (const chat of [viewport - 280, viewport - 580]) if (chat >= 260) cases.push({ viewport, chat });
  for (const viewport of [680, 520, 390]) cases.push({ viewport, chat: viewport });
  for (const { viewport, chat } of cases) for (const name of ['Quinn', 'A very long bot name that keeps going and going']) for (const live of [false, true]) {
    const tab = await browser.newPage({ viewport: { width: viewport, height: 400 } });
    await tab.setContent(page(chat, name, live));
    const boxes = await tab.evaluate(() => {
      const rect = (selector) => [...document.querySelectorAll(selector)].map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; });
      return { pill: rect('.chat__pill')[0], sessions: rect('.chat__sessions')[0], buttons: rect('.conversation-actions .icon-btn'), back: rect('.sidebar-back')[0], chat: rect('.chat')[0] };
    });
    await tab.close();
    const where = `viewport ${viewport}, chat ${chat}, "${name.slice(0, 8)}", live=${live}`;
    const firstButton = Math.min(...boxes.buttons.map(b => b.left));
    const overlap = (a, b) => a.right > b.left + 0.5 && b.right > a.left + 0.5;
    if (overlap(boxes.pill, boxes.sessions)) failures.push(`${where}: Bot pill overlaps Sessions`);
    if (boxes.sessions.right > firstButton + 0.5) failures.push(`${where}: Sessions (${boxes.sessions.right.toFixed(0)}) runs under the round buttons (${firstButton.toFixed(0)})`);
    if (boxes.pill.right > firstButton + 0.5) failures.push(`${where}: Bot pill runs under the round buttons`);
    if (boxes.pill.width < 30) failures.push(`${where}: Bot pill collapsed`);
    if (boxes.sessions.width < 30) failures.push(`${where}: Sessions pill collapsed`);
    if (viewport <= 700 && overlap(boxes.back, boxes.pill)) failures.push(`${where}: back button overlaps the Bot pill`);
  }
} finally { await browser.close(); }
assert.deepEqual(failures, [], failures.slice(0, 12).join('\n'));
console.log('PASS: the Bot pill, Sessions pill and round buttons never overlap at any width.');
