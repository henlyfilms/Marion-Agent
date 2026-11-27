// Dropping screenshots on a chat in the sidebar, in a real browser: the row lights up while files hover over it
// (also over its child elements), the drop opens that chat with the files in its box, and the chat that was open
// before gets none. Usage: npm run build && BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tests/sidebar-drop-live.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const workDir = await mkdtemp(join(tmpdir(), 'marion-sidebar-drop-'));
const port = process.env.MARION_TEST_PORT ?? '8817';
const app = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('../server/', import.meta.url),
  env: {
    ...process.env, DB_PATH: join(workDir, 'd.db'), PORT: port, HOST: '127.0.0.1', APP_URL: app, SERVER_URL: app, DEV_LOGIN: '1', MARION_NO_SCHEDULER: '1',
    MARION_LOCAL_MODEL_URL: 'http://127.0.0.1:9/v1',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stopped = once(child, 'exit');
let browser;
try {
  for (let i = 0; i < 80 && !(await fetch(app + '/api/health').catch(() => null))?.ok; i++) await new Promise(r => setTimeout(r, 100));
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(app);
  await page.evaluate(() => fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'drop@example.com' }) }));
  await page.goto(app);
  const input = page.locator('.composer__input');
  await input.waitFor();
  const first = await page.locator('.bot-row[aria-current="true"]').first().getAttribute('aria-label');
  await page.evaluate(() => fetch('/api/bots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Second' }) }));
  await page.reload();
  await input.waitFor();
  await page.locator(`.bot-row[aria-label="${first}"]:visible`).first().click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.composer-files li').count(), 0);

  const target = page.locator('.bot-row[aria-label="Second"]:visible').first();
  // Files from Finder / a screenshot thumbnail, as the browser hands them over.
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC5sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    data.items.add(new File([png], 'Screenshot 2026-11-26 at 9.41.02.png', { type: 'image/png' }));
    data.items.add(new File([png], 'Screenshot 2026-11-26 at 9.42.10.png', { type: 'image/png' }));
    return data;
  });
  const name = target.locator('.bot-row__name');
  await target.dispatchEvent('dragenter', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  // Moving onto a child element: enter child, then leave the row. The highlight must hold.
  await name.dispatchEvent('dragenter', { dataTransfer: transfer });
  await target.dispatchEvent('dragleave', { dataTransfer: transfer });
  await page.waitForTimeout(50);
  assert.match(await target.getAttribute('class'), /is-drop-target/, 'the hovered chat is highlighted');
  assert.equal(await target.locator('.bot-row__preview').textContent(), 'Drop to add to this chat');
  assert.equal(await page.locator('.bot-row.is-drop-target').count(), 1, 'only the hovered chat lights up');
  await target.dispatchEvent('drop', { dataTransfer: transfer });
  await page.waitForTimeout(500);
  assert.doesNotMatch(await target.getAttribute('class'), /is-drop-target/);
  assert.equal(await page.locator('.bot-row[aria-current="true"]:visible').first().getAttribute('aria-label'), 'Second', 'the drop opens that chat');
  assert.equal(await page.locator('.composer-files li').count(), 2, 'both screenshots are in its box');

  // Leaving without dropping clears the highlight.
  const back = page.locator(`.bot-row[aria-label="${first}"]:visible`).first();
  await back.dispatchEvent('dragenter', { dataTransfer: transfer });
  await back.dispatchEvent('dragleave', { dataTransfer: transfer });
  assert.equal(await page.locator('.bot-row.is-drop-target').count(), 0);
  await back.click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.composer-files li').count(), 0, 'the chat that was open before got nothing');
  await target.click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.composer-files li').count(), 2, 'the files are still waiting after switching back');
  console.log('PASS: screenshots dropped on a sidebar chat highlight it, open it, and wait in its box (not the previous chat).');
} finally {
  await browser?.close();
  child.kill();
  await stopped;
  await rm(workDir, { recursive: true, force: true });
}
