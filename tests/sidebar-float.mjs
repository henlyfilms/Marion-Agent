// Sidebar bottom: Tasks / Sessions (and Update available) float over the chat list with no solid bar around them.
// The chat list runs on behind the pills, the wrapper is click-through, the pills still take clicks, and the last chat
// can still scroll fully above them (with and without the Update pill). Source checks run without a browser; the
// measured check renders the real stylesheets in Chromium and skips if no Chromium can start (sandbox).
// Usage: node tests/sidebar-float.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sheets = ['tokens', 'base', 'shell', 'config', 'sheet', 'sessions', 'motion'];
const css = sheets.map(name => read(`web/src/styles/${name}.css`)).join('\n');

// ---------- source checks ----------
const sidebar = read('web/src/components/Sidebar.tsx');
const list = sidebar.indexOf('className="sidebar__list"');
const scroll = sidebar.indexOf('className="sidebar__scroll"');
const float = sidebar.indexOf('className="sidebar__float"');
const tools = sidebar.indexOf('<div className="sidebar__tools"><TasksIsland /><SessionsIsland /></div>');
const pill = sidebar.indexOf('update-pill--sidebar');
const bottom = sidebar.indexOf('className="sidebar__bottom"');
assert.ok(list >= 0 && list < scroll && scroll < float && float < tools && tools < pill && pill < bottom,
  'Tasks/Sessions and Update available live in the floating overlay inside the list, not in the bottom bar');
assert.ok(!sidebar.slice(bottom).includes('sidebar__tools'), 'the account footer bar no longer holds Tasks/Sessions');
const rule = (selector) => { const m = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`)); return m ? m[1] : ''; };
const floatRule = rule('.sidebar__float');
assert.match(floatRule, /position: absolute/, 'the overlay floats over the list');
assert.match(floatRule, /background: none/, 'no solid background behind the pills');
assert.match(floatRule, /pointer-events: none/, 'the transparent wrapper lets clicks/scrolls through');
assert.match(css, /\.sidebar__float :is\(\.sidebar-island, \.update-pill, button, a\) \{ pointer-events: auto; \}/, 'the pills stay clickable');
console.log('PASS source: floating, transparent, click-through Tasks/Sessions/Update overlay over the chat list.');

// ---------- measured check ----------
const fallbacks = [
  ...['chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chromium_headless_shell-1243/chrome-headless-shell-mac-x64/chrome-headless-shell']
    .map(path => join(homedir(), 'Library/Caches/ms-playwright', path)),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(existsSync);
const browser = await chromium.launch().catch(async () => (fallbacks.length ? chromium.launch({ executablePath: fallbacks[0] }) : null)).catch(() => null);
if (!browser) { console.log('SKIP: no Chromium could start here (blocked by the sandbox), so the measured layout check did not run.'); process.exit(0); }

const rows = Array.from({ length: 30 }, (_, i) => `<div class="bot-row" style="height:60px">Chat ${i + 1}</div>`).join('');
const page = (update) => `<!doctype html><meta charset="utf-8"><style>${css}</style>
<body style="margin:0;height:600px"><aside class="sidebar" style="height:600px">
<div class="sidebar__list">
  <div class="sidebar__scroll"><div class="bot-list">${rows}</div></div>
  <div class="sidebar__float">
    <div class="sidebar__tools"><button class="sidebar-island" id="tasks"><span class="sidebar-island__label">Tasks</span></button><button class="sidebar-island" id="sessions"><span class="sidebar-island__label">Sessions</span></button></div>
    ${update ? '<button class="update-pill update-pill--sidebar" id="update"><span>Update available</span><small>1 new</small></button>' : ''}
  </div>
</div>
<div class="sidebar__bottom"><div class="sidebar__footer"><button class="icon-btn">S</button></div></div>
</aside>`;
const failures = [];
try {
  for (const width of [1280, 520]) for (const update of [false, true]) {
    const tab = await browser.newPage({ viewport: { width, height: 600 } });
    await tab.setContent(page(update));
    const m = await tab.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const scroll = document.querySelector('.sidebar__scroll');
      const float = document.querySelector('.sidebar__float');
      const bg = getComputedStyle(float).backgroundColor;
      const tasks = box(document.querySelector('#tasks'));
      const hit = document.elementFromPoint(tasks.left + tasks.width / 2, tasks.top + tasks.height / 2);
      const top = box(float).top - 2;
      const behind = document.elementFromPoint(box(scroll).left + 4, top + 1); // a gap point inside the overlay's top edge
      scroll.scrollTop = scroll.scrollHeight;
      const rows = [...document.querySelectorAll('.bot-row')];
      const last = box(rows[rows.length - 1]);
      const pills = [...float.querySelectorAll('.sidebar-island, .update-pill')].map(box);
      return { bg, scrollBottom: box(scroll).bottom, floatBottom: box(float).bottom, floatTop: box(float).top,
        lastBottom: last.bottom, pillTop: Math.min(...pills.map(p => p.top)), hitTasks: hit?.closest('#tasks') != null,
        behindIsList: behind?.closest('.sidebar__scroll') != null };
    });
    await tab.close();
    const where = `${width}px${update ? ' + update' : ''}`;
    if (!/rgba\(0, 0, 0, 0\)|transparent/.test(m.bg)) failures.push(`${where}: overlay has a background (${m.bg})`);
    if (Math.abs(m.scrollBottom - m.floatBottom) > 1) failures.push(`${where}: list does not run behind the pills (list ends ${m.scrollBottom}, pills ${m.floatBottom})`);
    if (!m.hitTasks) failures.push(`${where}: Tasks pill is not clickable`);
    if (!m.behindIsList) failures.push(`${where}: overlay blocks the list behind it`);
    if (m.lastBottom > m.pillTop + 0.5) failures.push(`${where}: last chat cannot scroll above the pills (${m.lastBottom} > ${m.pillTop})`);
  }
} finally { await browser.close(); }
assert.deepEqual(failures, [], failures.join('\n'));
console.log('PASS measured: list runs behind transparent Tasks/Sessions/Update pills, pills clickable, last chat scrolls clear.');
