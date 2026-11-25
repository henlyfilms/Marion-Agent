// Motion check: plays every main transition in a real (headless) Chrome and reports what animated, for how
// long, and the worst frame gap while it ran. Fails on a transition that doesn't animate or drops below ~30 fps.
// Usage: MARION_TEST_URL=http://127.0.0.1:8847 BROWSER_EXECUTABLE=... node tests/motion-smooth.mjs
import { chromium } from 'playwright';

const app = process.env.MARION_TEST_URL ?? 'http://127.0.0.1:8847';
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const page = await browser.newPage({ viewport: { width: 1320, height: 860 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(app);
await page.evaluate(async () => {
  await fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 't@example.com' }) });
  const { bots } = await (await fetch('/api/bots')).json();
  if (bots.length < 2) await fetch('/api/bots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nova', avatarShape: 'marionberry', avatarColor: 'blue', avatarStemColor: null, mode: 'personal' }) });
});
await page.goto(app);
await page.waitForSelector('.chat__header');
await page.waitForTimeout(800);

const results = [];
async function measure(name, act, selector, ms = 700) {
  await page.evaluate(() => {
    window.__frames = []; let last = performance.now();
    const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 200) window.__raf = requestAnimationFrame(tick); };
    window.__raf = requestAnimationFrame(tick);
  });
  await act();
  await page.waitForTimeout(40);
  const anims = await page.evaluate((sel) => [...document.querySelectorAll(sel)].flatMap(el => el.getAnimations({ subtree: false }))
    .map(a => `${a.transitionProperty ?? a.animationName ?? 'waapi'} ${Math.round(a.effect.getTiming().duration)}ms`), selector);
  await page.waitForTimeout(ms);
  const worst = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return Math.round(Math.max(...window.__frames.slice(2, 40))); });
  results.push({ name, worstFrameMs: worst, animations: [...new Set(anims)].join(', ') || 'NONE' });
}

const row = (name) => page.locator(`.sidebar .bot-row[aria-label="${name}"]:visible`).first();
await measure('close side panel', () => page.click('.details-toggle'), '.details-slot, .details');
await measure('open side panel', () => page.click('.details-toggle'), '.details-slot, .details');
await measure('collapse sidebar', () => page.click('.sidebar-toggle'), '.sidebar');
await measure('expand sidebar', () => page.click('.sidebar-toggle'), '.sidebar');
await measure('switch bot', () => row('Nova').click(), '.transcript, .chat__header-main, .details__scroll');
await measure('switch bot back', () => row('Barry').click(), '.transcript, .chat__header-main, .details__scroll');
await measure('open Tasks', () => page.getByRole('button', { name: /^Tasks/ }).first().click(), '.app > .chat');
await measure('open Sessions', () => page.getByRole('button', { name: /^Sessions/ }).first().click(), '.app > .chat');
await measure('back to chat', () => row('Barry').click(), '.app > .chat');
await measure('model menu', () => page.click('.chat-model__trigger'), '.menu, .menu *');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await measure('bot right-click menu', () => row('Barry').click({ button: 'right' }), '.context-menu');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await measure('settings', () => page.keyboard.press('Meta+Comma'), '.sheet, .modal, .sheet-root *');
console.table(results);
if (errors.length) console.log('page errors:', errors);
await browser.close();
const bad = results.filter(r => r.animations === 'NONE' || r.worstFrameMs > 34);
if (bad.length) { console.log('NOT SMOOTH:', bad.map(b => b.name).join(', ')); process.exitCode = 1; }
