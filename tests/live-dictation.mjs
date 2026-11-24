// Live dictation: while the mic is still recording, words appear in the message box, and stopping
// keeps the final text. Uses a fake speech server and Chrome's fake microphone.
// Usage: npm run build && BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tests/live-dictation.mjs
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
const workDir = await mkdtemp(join(tmpdir(), 'marion-dictation-'));
const port = process.env.MARION_TEST_PORT ?? '8815';
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
  await page.evaluate(() => fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dictation@example.com' }) }));
  await page.goto(app);
  const input = page.locator('.composer__input');
  await input.waitFor();
  await page.locator('.composer__mic-anchor button').click();
  await page.waitForFunction(() => /hello/i.test(document.querySelector('.composer__input').value), null, { timeout: 8000 });
  assert.equal(await page.locator('.composer__mic-anchor button').getAttribute('aria-pressed'), 'true', 'words should appear while still recording');
  const live = await input.inputValue();
  await page.waitForTimeout(2600);
  await page.locator('.composer__mic-anchor button').click();
  await page.waitForFunction(() => document.querySelector('.composer__mic-anchor button').getAttribute('aria-pressed') === 'false' && !document.querySelector('.composer__btn.is-transcribing'), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const final = await input.inputValue();
  assert.equal(final, 'Hello there marion', `final text was "${final}"`);
  console.log(`PASS: live dictation shows "${live}" while recording, then keeps the final "${final}" (${requests} speech requests).`);
} finally {
  await browser?.close();
  child.kill();
  await stopped;
  speech.close();
  await rm(workDir, { recursive: true, force: true });
}
