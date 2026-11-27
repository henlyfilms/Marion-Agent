// Starred chats in the sidebar: the star is always visible (no hover) in the expanded list, the collapsed icon rail,
// at the desktop window's minimum width (840px), at the 701px layout edge and on the phone layout; it never sits on
// top of the unread / attention / completion badges; and screen readers hear "starred" in the chat's name.
// Mounts the real <Sidebar /> (bundled with esbuild) in Chromium with a fake /api, stars a chat from its context
// menu, collapses the sidebar, reloads ("reopen") and checks normal, selected and unread rows at every width.
// Usage: node tests/sidebar-star.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

// ---------- source checks (no browser needed) ----------
const sidebar = read('web/src/components/Sidebar.tsx');
assert.doesNotMatch(sidebar, /<Icon name="star"[^>]*aria-label=/, 'Icon drops aria-label (it is always aria-hidden), so it cannot carry "Starred"');
assert.match(sidebar, /starred/, 'the chat button names its starred state');
assert.doesNotMatch(sidebar, /className="bot-row__name">\{displayName\(bot\)\}\{bot\.pinned/, 'the row star is not inside the ellipsised name');
const shell = read('web/src/styles/shell.css');
assert.match(shell, /\.bot-row__avatar\.is-starred[^{]*\.status-dot/, 'a starred avatar moves its status dot off the star corner');
console.log('PASS source: star outside the ellipsis, starred in the accessible name, status dot clear of the star.');

// ---------- real component, server-rendered (runs everywhere, no browser needed) ----------
const bot = (o) => ({ label: '', description: '', instructions: '', avatarShape: 'berry', avatarColor: '#7046a3', avatarStemColor: null, mode: 'personal',
  isPrimary: false, kind: 'agent', effort: 'medium', voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', generation: 0, createdAt: 0, unread: 0,
  lastPreview: 'Hello there', lastActivityAt: Date.now(), pinned: false, ...o });
const LONG = 'A very long bot name that keeps going and going and going';
const seed = () => [
  { id: 'quinn', name: 'Quinn', pinned: true, unread: 3, avatarColor: '#7046a3' },
  { id: 'long', name: LONG, pinned: true, unread: 0, avatarColor: '#2f7dd1' },
  { id: 'sel', name: 'Selected Sam', pinned: true, unread: 2, avatarColor: '#18865b' },
  { id: 'plain', name: 'Plain Pat', pinned: false, unread: 1, avatarColor: '#bd253c' },
];
{
  const out = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'sidebar-star-ssr-'));
  await build({
    entryPoints: [join(root, 'tests/fixtures/sidebar-star-ssr.tsx')], bundle: true, outdir: out, format: 'cjs', platform: 'node', jsx: 'automatic',
    target: 'es2022', logLevel: 'error', alias: { '@shared': join(root, 'server/src') }, outExtension: { '.js': '.cjs' },
    define: { __MARION_BUILD__: '"test"', 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'dataurl', '.png': 'dataurl' },
  });
  // Just enough of a desktop-width browser for the app's modules to load.
  const media = { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  const saved = new Map();
  const noop = () => {};
  globalThis.window = globalThis;
  Object.assign(globalThis, {
    matchMedia: () => media, addEventListener: noop, removeEventListener: noop,
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key) },
    document: { documentElement: { dataset: {}, style: { setProperty: noop, removeProperty: noop }, setAttribute: noop, removeAttribute: noop, classList: { add: noop, remove: noop, toggle: noop } },
      addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
  });
  const { render } = createRequire(import.meta.url)(join(out, 'sidebar-star-ssr.cjs'));
  const rowsOf = (html) => html.slice(html.indexOf('class="bot-list"')).split('<button type="button" class="bot-row ').slice(1).map(chunk => chunk.slice(0, chunk.indexOf('</button>')));
  const check = (bots, opts, label) => {
    const rows = rowsOf(render(bots.map(bot), opts));
    assert.equal(rows.length, bots.length, `${label}: one row per chat`);
    bots.forEach((b, i) => {
      const row = rows.find(r => r.includes(`>${b.name}<`));
      const where = `${label} "${b.name}"`;
      assert.ok(row, `${where}: rendered`);
      const name = row.match(/aria-label="([^"]*)"/)[1];
      if (!b.pinned) {
        assert.equal(name, b.name, `${where}: unstarred name has no "starred"`);
        assert.doesNotMatch(row, /bot-row__star|bot-avatar__star|is-starred|data-starred/, `${where}: no star`);
        return;
      }
      assert.equal(name, `${b.name}, starred`, `${where}: accessible name says starred`);
      assert.match(row, /data-starred="true"/, `${where}: starred state on the button`);
      if (opts.collapsed) {
        assert.match(row, /class="bot-row__avatar is-starred[^"]*"><span class="bot-avatar"[^>]*>.*class="bot-avatar__star"/, `${where}: rail shows the star on the avatar`);
        if (b.unread) assert.match(row, /status-dot is-unread/, `${where}: unread dot still shown (moved to the top corner)`);
      } else {
        assert.match(row, /<span class="bot-row__title"><span class="bot-row__name">[^<]*<\/span><svg[^>]*class="[^"]*bot-row__star/, `${where}: row star sits after the name, outside its ellipsis`);
      }
      if (opts.selected === b.id) assert.match(row, /^[^"]*is-selected/, `${where}: selected`);
    });
  };
  for (const collapsed of [false, true]) for (const selected of [null, 'sel']) {
    const label = `ssr ${collapsed ? 'collapsed' : 'expanded'}${selected ? ' selected' : ''}`;
    check(seed(), { collapsed, selected }, label);
    // Starring "Plain Pat" (what the context menu / swipe does to the store) adds its star and its "starred" name.
    check(seed().map(b => b.id === 'plain' ? { ...b, pinned: true } : b), { collapsed, selected }, `${label} after starring`);
  }
  console.log('PASS ssr: real Sidebar — expanded and collapsed, normal/selected/unread, before and after starring.');
}

// ---------- real component in Chromium ----------
const fallbacks = [
  ...['chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chromium_headless_shell-1243/chrome-headless-shell-mac-x64/chrome-headless-shell']
    .map(path => join(homedir(), 'Library/Caches/ms-playwright', path)),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(existsSync);
const browser = await chromium.launch().catch(async () => (fallbacks.length ? chromium.launch({ executablePath: fallbacks[0] }) : null)).catch(() => null);
if (!browser) { console.log('SKIP browser: no Chromium could start here (blocked by the sandbox), so the measured layout check did not run.'); process.exit(0); }

const out = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'sidebar-star-'));
await build({
  entryPoints: [join(root, 'tests/fixtures/sidebar-star-harness.tsx')], bundle: true, outdir: out, format: 'esm', jsx: 'automatic',
  target: 'es2022', logLevel: 'error', alias: { '@shared': join(root, 'server/src') },
  define: { __MARION_BUILD__: '"test"', 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'dataurl', '.png': 'dataurl' },
});
const js = readFileSync(join(out, 'sidebar-star-harness.js'), 'utf8');
const css = ['tokens', 'base', 'shell', 'workfx', 'motion', 'sessions'].map(name => read(`web/src/styles/${name}.css`)).join('\n');
const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><style>body{margin:0}#root{height:100vh;display:flex}</style>
<body><div id="root"></div><script type="module" src="/harness.js"></script>`;

let server = seed();

async function open(context, { width, selected = 'sel', desktop = false }) {
  const tab = await context.newPage({ viewport: { width, height: 700 } });
  tab.on('pageerror', error => { throw error; });
  await tab.route('http://marion.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    const patch = url.pathname.match(/^\/api\/bots\/([^/]+)$/);
    if (patch && route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      server = server.map(bot => bot.id === patch[1] ? { ...bot, ...body } : bot);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ bot: server.find(bot => bot.id === patch[1]) }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not in test"}' });
  });
  await tab.addInitScript(({ bots, selected, desktop }) => {
    window.__BOTS__ = bots; window.__SELECTED__ = selected;
    if (desktop) document.documentElement.dataset.desktopWindow = 'true';
  }, { bots: server, selected, desktop });
  await tab.goto('http://marion.test/');
  await tab.waitForSelector('.bot-list .bot-row');
  await tab.mouse.move(0, 0); // nothing hovered
  await tab.waitForTimeout(500); // star-pop and collapse transitions settle
  return tab;
}

/** Every starred chat: star visible, unclipped, uncovered and clear of status badges; the name says "starred". */
async function checkStars(tab, label) {
  const rows = await tab.evaluate(() => [...document.querySelectorAll('.bot-row')].map(button => {
    const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const star = button.querySelector('.bot-row__star, .bot-avatar__star');
    let clipped = false;
    if (star) {
      const s = star.getBoundingClientRect();
      for (let el = star.parentElement; el && el !== document.body; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          const c = el.getBoundingClientRect();
          if (s.left < c.left - 0.5 || s.right > c.right + 0.5 || s.top < c.top - 0.5 || s.bottom > c.bottom + 0.5) clipped = true;
        }
      }
    }
    const style = star && getComputedStyle(star);
    const center = star && (() => { const r = star.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); })();
    return {
      name: button.getAttribute('aria-label'), variant: [...button.classList].find(c => c.startsWith('bot-row--')),
      selected: button.classList.contains('is-selected'), visibleRow: button.getBoundingClientRect().width > 0,
      star: star && box(star), clipped, shown: !!style && style.visibility === 'visible' && Number(style.opacity) > 0.9 && style.display !== 'none',
      onTop: !!center && (center === star || star.contains(center)),
      badges: [...button.querySelectorAll('.status-dot, .completion-mark, .bot-row__spinner, .bot-row__needs')].map(box),
    };
  }));
  const starredIds = new Set(server.filter(bot => bot.pinned).map(bot => bot.name));
  for (const row of rows.filter(row => row.visibleRow)) {
    const base = row.name.replace(/, starred$/i, '');
    const where = `${label} ${row.variant} "${base}"${row.selected ? ' (selected)' : ''}`;
    if (!starredIds.has(base)) { assert.ok(!row.star && !/starred/i.test(row.name), `${where}: not starred, no star`); continue; }
    assert.match(row.name, /starred/i, `${where}: accessible name says starred`);
    assert.ok(row.star && row.star.width >= 5 && row.star.height >= 5, `${where}: star rendered`);
    assert.ok(row.shown, `${where}: star visible without hover`);
    assert.ok(!row.clipped, `${where}: star not clipped (e.g. by the name's ellipsis)`);
    assert.ok(row.onTop, `${where}: nothing drawn over the star`);
    for (const badge of row.badges) {
      const overlap = Math.min(row.star.right, badge.right) - Math.max(row.star.left, badge.left) > 0.5
        && Math.min(row.star.bottom, badge.bottom) - Math.max(row.star.top, badge.top) > 0.5;
      assert.ok(!overlap, `${where}: star overlaps a status badge ${JSON.stringify({ star: row.star, badge })}`);
    }
  }
  // Assistive tech sees the same thing through the accessibility tree, not only the attribute.
  for (const bot of server.filter(bot => bot.pinned)) {
    const count = await tab.getByRole('button', { name: new RegExp(`^${bot.name.replace(/[()]/g, '\\$&')}, starred$`) }).count();
    assert.ok(count >= 1, `${label}: "${bot.name}" exposed as starred to assistive tech`);
  }
  const plain = await tab.getByRole('button', { name: /^Plain Pat$/ }).count();
  if (!server.find(bot => bot.id === 'plain').pinned) assert.ok(plain >= 1, `${label}: unstarred chat has no "starred" in its name`);
  return rows.filter(row => row.visibleRow && row.star).length;
}

try {
  const cases = [
    { width: 1280, desktop: true, label: 'desktop 1280' },
    { width: 840, desktop: true, label: 'desktop min 840' },
    { width: 1280, desktop: false, label: 'web 1280' },
    { width: 701, desktop: false, label: 'web 701' },
  ];
  for (const { width, desktop, label } of cases) {
    server = seed();
    const context = await browser.newContext();
    let tab = await open(context, { width, desktop });
    assert.equal(await checkStars(tab, `${label} expanded`), 3);

    // Star "Plain Pat" from its context menu: the star appears straight away and the name changes.
    await tab.getByRole('button', { name: /^Plain Pat$/ }).click({ button: 'right' });
    await tab.getByRole('menuitem', { name: 'Star chat' }).click();
    await tab.getByRole('button', { name: 'Plain Pat, starred' }).waitFor();
    await tab.mouse.move(0, 0);
    await tab.waitForTimeout(500);
    assert.equal(await checkStars(tab, `${label} after starring`), 4);

    // Collapse to the icon rail: every star still shows on its avatar, clear of the unread dots.
    await tab.getByRole('button', { name: 'Collapse sidebar' }).click();
    await tab.mouse.move(0, 0);
    await tab.waitForTimeout(600);
    assert.equal(await tab.locator('.sidebar.is-collapsed').count(), 1, `${label}: collapsed`);
    assert.equal(await checkStars(tab, `${label} collapsed`), 4);

    // Reopen: collapse and stars persist, nothing selected and selected both fine.
    await tab.close();
    tab = await open(context, { width, desktop, selected: null });
    assert.equal(await tab.locator('.sidebar.is-collapsed').count(), 1, `${label}: still collapsed after reopening`);
    assert.equal(await checkStars(tab, `${label} reopened collapsed`), 4);
    await tab.getByRole('button', { name: 'Expand sidebar' }).click();
    await tab.mouse.move(0, 0);
    await tab.waitForTimeout(600);
    assert.equal(await checkStars(tab, `${label} reopened expanded`), 4);
    await context.close();
    console.log(`PASS ${label}: expanded, starred, collapsed, reopened — stars visible, unclipped, clear of badges, announced.`);
  }

  // Phone layout: the favourites strip (big avatars) and the list rows.
  server = seed();
  const context = await browser.newContext();
  const tab = await open(context, { width: 390, selected: null });
  assert.ok(await tab.locator('.sidebar__featured .bot-row--featured').count() > 0, 'phone: favourites strip shown');
  assert.ok(await checkStars(tab, 'phone 390') >= 3);
  await context.close();
  console.log('PASS phone 390: favourites and rows — stars visible, unclipped, clear of badges, announced.');
} finally {
  await browser.close();
}
process.exit(0); // the app modules loaded for the server render keep timers alive
