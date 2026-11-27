// Opening Settings while dictating never pauses or stops it: words keep landing in the chat dictation was started in
// (saved into its draft while the box is off screen), Esc that closes Settings does not cancel it, and the mic stays on.
// Uses a fake browser speech engine, no speech server and no microphone.
// Usage: npm run build && BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tests/dictation-leave.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const workDir = await mkdtemp(join(tmpdir(), 'marion-leave-'));
const port = process.env.MARION_TEST_PORT ?? '8817';
const app = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('../server/', import.meta.url),
  env: { ...process.env, DB_PATH: join(workDir, 'd.db'), PORT: port, HOST: '127.0.0.1', APP_URL: app, SERVER_URL: app, DEV_LOGIN: '1', MARION_NO_SCHEDULER: '1', MARION_LOCAL_MODEL_URL: 'http://127.0.0.1:9/v1' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stopped = once(child, 'exit');
let browser;
try {
  for (let i = 0; i < 80 && !(await fetch(app + '/api/health').catch(() => null))?.ok; i++) await new Promise(r => setTimeout(r, 100));
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const page = await (await browser.newContext()).newPage();
  // A fake speech engine the test drives: __say(final, interim) delivers finished and still-unfinished words.
  await page.addInitScript(() => {
    class FakeRecognition {
      start() { window.__recognition = this; }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = window.webkitSpeechRecognition = FakeRecognition;
    window.__say = (final, interim) => {
      const results = [];
      if (final) results.push(Object.assign([{ transcript: final }], { isFinal: true }));
      if (interim) results.push(Object.assign([{ transcript: interim }], { isFinal: false }));
      window.__recognition.onresult({ results });
    };
  });
  await page.goto(app);
  await page.evaluate(() => fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'leave@example.com' }) }));
  await page.goto(app);
  const input = page.locator('.composer__input');
  await input.waitFor();
  const drafts = () => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('marion.drafts.v1') || '{}')).join('|'));

  await page.locator('.composer__mic-anchor button').click();
  await page.waitForFunction(() => !!window.__recognition);
  await page.evaluate(() => window.__say('first words', 'and still being heard'));
  await page.waitForFunction(() => /still being heard/.test(document.querySelector('.composer__input').value));
  // Open Settings while the last words are still unfinished: dictation keeps going.
  await page.locator('.account__btn[aria-label="Settings"]').first().click();
  await page.waitForTimeout(300);
  assert.equal(!!(await page.evaluate(() => window.__recognition)), true, 'the speech engine is still running');
  await page.evaluate(() => window.__say('and still being heard plus more from settings'));
  await page.waitForTimeout(200);
  assert.match(await drafts(), /First words and still being heard plus more from settings/, 'words said in Settings land in the original chat draft');
  await page.keyboard.press('Escape');
  await input.waitFor();
  assert.match(await input.inputValue(), /First words and still being heard plus more from settings/, 'returning shows the full dictated text');
  assert.equal(await page.locator('.composer__mic-anchor button').getAttribute('aria-pressed'), 'true', 'the mic is still on after closing Settings');
  console.log('PASS: Settings never pauses dictation; its words land in the chat it was started in.');
} finally {
  await browser?.close();
  child.kill();
  await stopped;
  await rm(workDir, { recursive: true, force: true });
}
