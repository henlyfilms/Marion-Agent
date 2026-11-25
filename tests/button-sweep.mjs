// Button sweep: on every main screen, clicks every visible button one by one (skipping ones that delete,
// sign out, install, call or change the computer) and reports page errors and buttons that do nothing.
// Usage: MARION_TEST_URL=http://127.0.0.1:8847 BROWSER_EXECUTABLE=... node tests/button-sweep.mjs
import { chromium } from 'playwright';

const app = process.env.MARION_TEST_URL ?? 'http://127.0.0.1:8847';
const SKIP = /delete|log ?out|remove|install|update now|call|reset|start (new|fresh)|dictate|record|sleep|wake|connect|export|download|copy|import|make primary|stop|send|discard|save|refresh|check now|forget|revoke|ask again|new passphrase|end/i;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const page = await browser.newPage({ viewport: { width: 1320, height: 860 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|favicon|logos\.composio/.test(m.text())) errors.push(m.text()); });
await page.goto(app);
await page.evaluate(() => fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 't@example.com' }) }));

const report = [];
const visible = (scope) => [...document.querySelectorAll(scope)].flatMap(root => [...root.querySelectorAll('button:not([disabled]), [role="button"], [role="tab"], [role="switch"]')])
  .filter(b => { const r = b.getBoundingClientRect(); return r.width && r.height && r.bottom > 0 && r.top < innerHeight && getComputedStyle(b).visibility !== 'hidden' && !b.closest('[aria-hidden="true"], [inert]'); });
async function ready(open) {
  await page.goto(app);
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.goto(app);
  await page.waitForSelector('.chat__header');
  await page.waitForTimeout(450);
  await open();
  await page.waitForTimeout(450);
}
/** Clicks each button inside `scope` on a fresh copy of the screen; reports errors and buttons that change nothing. */
async function sweep(screen, scope, open) {
  await ready(open);
  const labels = await page.evaluate(visible.toString().replace(/^/, 'const visible = ') + `; visible(${JSON.stringify(scope)}).map(b => (b.getAttribute('aria-label') || b.innerText || b.title || '').trim().replace(/\\s+/g, ' ').slice(0, 40))`);
  let clicked = 0; const dead = [];
  for (const [i, label] of labels.entries()) {
    const nth = labels.slice(0, i).filter(l => l === label).length;
    if (!label || SKIP.test(label)) continue;
    if (clicked) await ready(open);
    const before = errors.length;
    await page.evaluate(([scope, label, nth, src]) => {
      const visible = eval(src);
      window.__m = 0; window.__obs?.disconnect();
      window.__obs = new MutationObserver(l => { window.__m += l.length; });
      window.__obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      const same = visible(scope).filter(b => (b.getAttribute('aria-label') || b.innerText || b.title || '').trim().replace(/\s+/g, ' ').slice(0, 40) === label);
      same[nth]?.setAttribute('data-sweep', 'target');
    }, [scope, label, nth, visible.toString()]);
    const marked = await page.locator('[data-sweep="target"]').count();
    await page.locator('[data-sweep="target"]').click({ timeout: 2500 }).catch(e => report.push(`${screen}: "${label}" could not be clicked (marked=${marked}; ${e.message.split('\n').slice(0, 6).join(' / ')})`));
    await page.waitForTimeout(350);
    clicked++;
    if ((await page.evaluate(() => window.__m)) <= 1) dead.push(label);
    if (errors.length > before) report.push(`${screen}: "${label}" → ${errors.slice(before).join(' | ')}`);
  }
  console.log(`${screen}: clicked ${clicked}${dead.length ? `; no visible response from: ${dead.join(', ')}` : ''}`);
}

const nothing = async () => {};
const botSettings = (tab) => async () => { await page.locator('.details__identity').click(); if (tab) await page.locator('.bot-settings .cfg-nav__item', { hasText: tab }).click(); };
await sweep('sidebar', '.sidebar', nothing);
await sweep('chat', '.app > .chat', nothing);
await sweep('side panel', '.details', nothing);
await sweep('side panel Tasks tab', '.details__scroll', () => page.locator('.details__tabs button', { hasText: 'Tasks' }).click());
await sweep('side panel Library tab', '.details__scroll', () => page.locator('.details__tabs button', { hasText: 'Library' }).click());
for (const tab of ['', 'Skills', 'Memories', 'Routines', 'Apps']) await sweep(`bot settings ${tab || 'General'}`, '.bot-settings', botSettings(tab));
await sweep('Tasks view', '.app > .chat', () => page.getByRole('button', { name: /^Tasks/ }).first().click());
await sweep('Sessions view', '.app > .chat', () => page.getByRole('button', { name: /^Sessions/ }).first().click());
await sweep('settings', '.sheet, .settings', () => page.keyboard.press('Meta+Comma'));
console.log(report.length ? `\nPROBLEMS:\n${report.join('\n')}` : '\nNo errors from any button.');
await browser.close();
if (report.length) process.exitCode = 1;
