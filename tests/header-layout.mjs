// Chat header: the bot's nametag is centred, shows the full bot name (e.g. "Kanye (Marion Agent)"), and never runs under
// the round Search / Share / panel buttons. There is no Sessions button in the header any more (Sessions lives in the
// sidebar), and no "Start Claude Cloud…" button anywhere. Renders the real stylesheets with the real header markup in
// Chromium at many widths; the source checks run without a browser.
// Usage: node tests/header-layout.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const css = ['tokens', 'base', 'shell', 'chat', 'sessions'].map(name => read(`web/src/styles/${name}.css`)).join('\n');

// ---------- source checks (no browser needed) ----------
const webFiles = (dir) => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? webFiles(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
});
const web = webFiles(fileURLToPath(new URL('../web/src', import.meta.url))).map(path => ({ path, text: readFileSync(path, 'utf8') }));
for (const { path, text } of web) {
  assert.doesNotMatch(text, /Start Claude Cloud/, `${path}: the "Start Claude Cloud…" button is gone`);
  assert.doesNotMatch(text, /CloudSessionModal|BotSessionsButton|BotSessionsDrawer|chat__sessions|utility-cloud-action/, `${path}: no leftovers of the header Sessions button or Cloud modal`);
}
assert.ok(!existsSync(new URL('../web/src/components/sessions/BotSessionsPanel.tsx', import.meta.url)), 'the header-only Sessions drawer is removed');
const chatView = read('web/src/components/ChatView.tsx');
assert.match(chatView, /className="chat__pill-name">\{bot\.name\}/, 'the nametag shows the bot name');
assert.doesNotMatch(chatView, /Sessions/, 'no Sessions button in the chat header');
assert.match(read('web/src/components/Sidebar.tsx'), /<SessionsIsland \/>/, 'the sidebar Sessions entry stays');
// Cloud actions still work without the button: the bot tool and the in-app Cloud cards.
assert.match(read('server/src/agent/tools.ts'), /name: 'start_cloud_session'/);
assert.match(read('web/src/components/cards/Cards.tsx'), /case 'cloud': return <CloudCard/);
// Centring and full-width rules.
assert.match(css, /\.chat__header::before, \.chat__header::after \{ content: ''; flex: 1 1 0; min-width: 0; \}/, 'equal flexible spacers centre the nametag');
assert.match(css, /\.chat__header::after \{ min-width: calc\(var\(--conversation-actions-width\) \+ 8px\); \}/, 'the right spacer keeps clear of the round buttons');
assert.match(css, /\.chat__pill-name \{[^}]*max-width: none;/, 'no max-width on the name');
assert.doesNotMatch(css, /\.chat__header \{[^}]*justify-content: flex-start/, 'no left-aligned header at any width');
console.log('PASS source: no Start Claude Cloud or header Sessions button; Cloud tool and cards kept; centring and full-width rules in place.');

// Playwright's own Chromium may be a different version than the one downloaded; fall back to any Chromium on this Mac.
const fallbacks = [
  ...['chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chromium_headless_shell-1243/chrome-headless-shell-mac-x64/chrome-headless-shell']
    .map(path => join(homedir(), 'Library/Caches/ms-playwright', path)),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(existsSync);
const browser = await chromium.launch().catch(async () => (fallbacks.length ? chromium.launch({ executablePath: fallbacks[0] }) : null)).catch(() => null);
if (!browser) { console.log('SKIP: no Chromium could start here (blocked by the sandbox), so the measured layout check did not run.'); process.exit(0); }

const page = (width, name) => `<!doctype html><meta charset="utf-8"><style>${css}</style>
<body style="margin:0"><main class="chat" style="position:relative;width:${width}px;height:240px">
<header class="chat__header">
  <button class="icon-btn sidebar-back">‹</button>
  <div class="chat__header-main">
    <span class="chat__pill-anchor"><button class="chat__pill"><span class="bot-avatar" style="width:26px;height:26px;display:inline-block;flex-shrink:0"></span><span class="chat__pill-name">${name}</span></button></span>
  </div>
</header>
<div class="conversation-actions"><button class="icon-btn">1</button><button class="icon-btn">2</button><button class="icon-btn">3</button></div>
</main>`;
const failures = [];
try {
  const cases = [];
  for (const viewport of [1440, 1280, 1100]) for (const chat of [420, 460, 560, 760, 1100]) cases.push({ viewport, chat });
  for (const viewport of [1000, 900, 800, 720, 701]) for (const chat of [viewport - 280, viewport - 580]) if (chat >= 260) cases.push({ viewport, chat });
  for (const viewport of [680, 520, 390]) cases.push({ viewport, chat: viewport });
  const names = ['Quinn', 'Kanye (Marion Agent)', 'Barry (Marion Life)', 'A very long bot name that keeps going and going and going'];
  for (const { viewport, chat } of cases) for (const name of names) {
    const tab = await browser.newPage({ viewport: { width: viewport, height: 400 } });
    await tab.setContent(page(chat, name));
    const m = await tab.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
      const label = document.querySelector('.chat__pill-name');
      return { pill: rect(document.querySelector('.chat__pill')), chat: rect(document.querySelector('.chat')), back: rect(document.querySelector('.sidebar-back')),
        buttons: [...document.querySelectorAll('.conversation-actions .icon-btn')].map(rect), truncated: label.scrollWidth > label.clientWidth + 0.5 };
    });
    await tab.close();
    const where = `viewport ${viewport}, chat ${chat}, "${name.slice(0, 20)}"`;
    const firstButton = Math.min(...m.buttons.map(b => b.left));
    const centre = (m.pill.left + m.pill.right) / 2;
    const chatCentre = (m.chat.left + m.chat.right) / 2;
    if (m.pill.right > firstButton + 0.5) failures.push(`${where}: nametag runs under the round buttons`);
    if (m.pill.width < 30) failures.push(`${where}: nametag collapsed`);
    if (viewport <= 700 && m.back.right > m.pill.left + 0.5) failures.push(`${where}: back button overlaps the nametag`);
    const real = name.length <= 24;
    // Desktop chats of any usual width show real bot names in full.
    if (real && viewport > 700 && chat >= 420 && m.truncated) failures.push(`${where}: name cut off ("…")`);
    // With room on both sides, the nametag sits in the middle of the chat.
    if (viewport > 700 && real && chat >= 560 && Math.abs(centre - chatCentre) > 1) failures.push(`${where}: not centred (${centre.toFixed(1)} vs ${chatCentre.toFixed(1)})`);
  }
} finally { await browser.close(); }
assert.deepEqual(failures, [], failures.slice(0, 12).join('\n'));
console.log('PASS measured: the nametag is centred, shows full names (Kanye (Marion Agent), Barry (Marion Life)) and never overlaps the buttons.');
