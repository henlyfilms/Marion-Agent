// UI sweep: opens every main screen at desktop, split-view and iPhone sizes and checks for console
// errors, sideways scrolling, clipped text, the sidebar footer spacing and the empty composer height.
// Usage: npm run build && BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tests/ui-sweep.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const workDir = await mkdtemp(join(tmpdir(), 'marion-sweep-'));
const port = process.env.MARION_TEST_PORT ?? '8814';
const app = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('../server/', import.meta.url),
  env: { ...process.env, DB_PATH: join(workDir, 'sweep.db'), PORT: port, HOST: '127.0.0.1', APP_URL: app, SERVER_URL: app, DEV_LOGIN: '1', MARION_NO_SCHEDULER: '1', MARION_LOCAL_MODEL_URL: 'http://127.0.0.1:9/v1' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stopped = once(child, 'exit');
const problems = [];
let browser;
try {
  for (let i = 0; i < 80 && !(await fetch(app + '/api/health').catch(() => null))?.ok; i++) await new Promise(r => setTimeout(r, 100));
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const sizes = [['desktop', 1320, 880], ['split', 780, 820], ['phone', 390, 844]];
  for (const [label, width, height] of sizes) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: label === 'phone', isMobile: label === 'phone' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|favicon|logos\.composio/.test(m.text())) errors.push(m.text()); });
    await page.goto(app);
    await page.evaluate(async () => {
      await fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sweep@example.com' }) });
    });
    await page.goto(app);
    await page.waitForSelector('.sidebar');
    const check = async (screen) => {
      const found = await page.evaluate(() => {
        const out = [];
        if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
        for (const el of document.querySelectorAll('body *')) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || !el.getClientRects().length) continue;
          const box = el.getBoundingClientRect();
          // Items inside a deliberate side-scrolling strip (settings tabs, profile tabs on phone) are fine.
          const inStrip = (() => { for (let p = el.parentElement; p; p = p.parentElement) { if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX)) return true; } return false; })();
          if (box.width && box.right > innerWidth + 2 && style.position !== 'fixed' && !inStrip && !el.closest('[aria-hidden="true"], .chat-swipe, .bot-list')) {
            out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} sticks out on the right (${Math.round(box.right)} > ${innerWidth})`);
          }
          if (['auto', 'scroll'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 2 && !el.matches('.bot-profile__nav, .settings-home, textarea')) {
            out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} scrolls sideways`);
          }
        }
        return [...new Set(out)].slice(0, 8);
      });
      for (const f of found) problems.push(`[${label}] ${screen}: ${f}`);
    };

    if (label !== 'phone') {
      // Sidebar footer: same space above the buttons (to the divider) as below them.
      const gap = await page.evaluate(() => {
        const footer = document.querySelector('.sidebar__footer').getBoundingClientRect();
        const button = document.querySelector('.sidebar__footer .icon-btn').getBoundingClientRect();
        const border = parseFloat(getComputedStyle(document.querySelector('.sidebar__footer')).borderTopWidth);
        return { above: button.top - footer.top - border, below: footer.bottom - button.bottom };
      });
      if (Math.abs(gap.above - gap.below) > 0.5) problems.push(`[${label}] footer spacing ${gap.above}px above vs ${gap.below}px below`);
    }
    if (label === 'phone') { await page.locator('.bot-row').first().click(); await page.waitForTimeout(400); }
    await page.waitForSelector('.composer__input');
    const composer = await page.evaluate(() => document.querySelector('.composer').getBoundingClientRect().height);
    if (composer > 52) problems.push(`[${label}] empty composer is ${composer}px tall`);
    await check('chat');

    if (label !== 'phone') {
      await page.locator('.details__identity').click();
      await page.waitForSelector('.bot-settings');
      for (const section of ['Skills', 'Memories', 'Routines', 'Theme', 'Access', 'General']) await page.locator('.bot-settings .cfg-nav__item', { hasText: section }).click();
      await check('bot settings');
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => document.querySelector('.composer__plus-anchor button').click());
    await page.locator('.menu__item', { hasText: 'Teach by screen recording' }).click();
    await page.waitForSelector('.teach-modal');
    await page.waitForTimeout(250);
    await check('teach');
    await page.keyboard.press('Escape');

    await page.goto(app);
    await page.waitForSelector('.sidebar');
    await page.locator('.sidebar__create').click();
    await page.locator('button', { hasText: 'Start from a template' }).click();
    await page.waitForSelector('.template-card');
    await page.waitForTimeout(250);
    await check('templates');
    await page.locator('.template-card', { hasText: 'Executive' }).click();
    await page.waitForSelector('.bot-profile__cta');
    await page.waitForTimeout(250);
    await check('template profile');
    await page.keyboard.press('Escape');

    for (const section of ['Notifications', 'Marion Life']) {
      await page.keyboard.press('Meta+Comma');
      await page.waitForSelector('.settings-sheet');
      await page.locator('.sheet-row', { hasText: section }).click();
      // Pages push in from the right on a phone; measure once they've landed.
      await page.locator('.settings-page').evaluate(el => Promise.allSettled(el.getAnimations().map(a => a.finished)));
      await check(`settings: ${section}`);
      await page.keyboard.press('Escape');
    }
    for (const e of errors) problems.push(`[${label}] console: ${e}`);
    await context.close();
  }
  if (problems.length) console.log(problems.join('\n'));
  assert.equal(problems.length, 0, `${problems.length} UI problems`);
  console.log('PASS: chat, profile, templates, teach and settings screens at desktop, split and phone sizes: no console errors, no sideways scrolling, symmetric footer, one-line composer.');
} finally {
  await browser?.close();
  child.kill();
  await stopped;
  await rm(workDir, { recursive: true, force: true });
}
