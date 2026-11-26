// Drafts are never lost: typed text survives switching chats and reloading, and leaving a chat while
// dictating keeps the dictated words in that chat's box. Fake speech server + Chrome's fake microphone.
// Usage: npm run build && BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tests/drafts-keep.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

let requests = 0;
const speech = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  requests++;
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: requests < 3 ? 'hello' : 'hello there marion' }));
});
await new Promise(resolve => speech.listen(0, '127.0.0.1', resolve));
const workDir = await mkdtemp(join(tmpdir(), 'marion-drafts-'));
const port = process.env.MARION_TEST_PORT ?? '8816';
const app = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('../server/', import.meta.url),
  env: {
    ...process.env, DB_PATH: join(workDir, 'd.db'), PORT: port, HOST: '127.0.0.1', APP_URL: app, SERVER_URL: app, DEV_LOGIN: '1', MARION_NO_SCHEDULER: '1',
    MARION_STT_URL: `http://127.0.0.1:${speech.address().port}/v1/audio/transcriptions`, MARION_LOCAL_MODEL_URL: 'http://127.0.0.1:9/v1',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stopped = once(child, 'exit');
let browser;
try {
  for (let i = 0; i < 80 && !(await fetch(app + '/api/health').catch(() => null))?.ok; i++) await new Promise(r => setTimeout(r, 100));
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  await page.goto(app);
  await page.evaluate(() => fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'drafts@example.com' }) }));
  await page.goto(app);
  const input = page.locator('.composer__input');
  await input.waitFor();
  const first = await page.locator('.bot-row[aria-current="true"]').first().getAttribute('aria-label');
  await page.evaluate(() => fetch('/api/bots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Second' }) }));
  await page.reload();
  await input.waitFor();
  const open = async name => { await page.locator(`.bot-row[aria-label="${name}"]:visible`).first().click(); await page.waitForTimeout(400); };

  await input.fill('keep me please');
  await open('Second');
  assert.equal(await input.inputValue(), '', 'the other chat starts empty');
  await open(first);
  assert.equal(await input.inputValue(), 'keep me please', 'typed text is back after switching chats');
  await page.reload();
  await input.waitFor();
  await open(first);
  assert.equal(await input.inputValue(), 'keep me please', 'typed text survives a reload');
  console.log('PASS: typed text survives switching chats and reloading.');

  await input.fill('Note:');
  await page.locator('.composer__mic-anchor button').click();
  await page.waitForFunction(() => /hello/i.test(document.querySelector('.composer__input').value), null, { timeout: 8000 });
  await open('Second');
  await page.waitForTimeout(2500);
  await open(first);
  const kept = await input.inputValue();
  assert.match(kept, /^Note: hello/i, `dictated words were lost: "${kept}"`);
  assert.equal(await page.locator('.composer__mic-anchor button').getAttribute('aria-pressed'), 'false', 'the mic is off after leaving');
  console.log(`PASS: leaving a chat mid-dictation keeps "${kept}".`);
} finally {
  await browser?.close();
  child.kill();
  await stopped;
  speech.close();
  await rm(workDir, { recursive: true, force: true });
}
