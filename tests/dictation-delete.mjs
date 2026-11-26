// Backspace/Delete while dictating: edits to finished text are kept, words still being heard can be deleted for good,
// and dictation keeps running and keeps adding words.
// Uses a fake browser speech engine, no speech server and no microphone.
// Usage: npm run build && BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tests/dictation-delete.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const workDir = await mkdtemp(join(tmpdir(), 'marion-delete-'));
const port = process.env.MARION_TEST_PORT ?? '8818';
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
  // A fake speech engine the test drives: __say([[text, isFinal], ...]) is the engine's whole result list.
  await page.addInitScript(() => {
    class FakeRecognition {
      start() { window.__recognition = this; }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = window.webkitSpeechRecognition = FakeRecognition;
    window.__say = (list) => window.__recognition.onresult({ results: list.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) });
  });
  await page.goto(app);
  await page.evaluate(() => fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'delete@example.com' }) }));
  await page.goto(app);
  const input = page.locator('.composer__input');
  await input.waitFor();
  const mic = page.locator('.composer__mic-anchor button');
  const value = () => input.inputValue();
  const settle = () => page.waitForTimeout(150);

  await mic.click();
  await page.waitForFunction(() => !!window.__recognition);
  await page.evaluate(() => window.__say([['first words', true], ['and still being heard', false]]));
  await page.waitForFunction(() => document.querySelector('.composer__input').value === 'First words and still being heard');

  // 1. Backspace inside the words still being heard deletes them (it used to snap back).
  await input.focus();
  await page.keyboard.press('End');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  await settle();
  assert.equal(await value(), 'First words and still being', 'Backspace removes words that are still being heard');
  // The engine keeps extending the same utterance: the deleted word must not come back.
  await page.evaluate(() => window.__say([['first words', true], ['and still being heard now', false]]));
  await settle();
  assert.equal(await value(), 'First words and still being now', 'deleted heard words are not restored by the next update');
  assert.equal(await mic.getAttribute('aria-pressed'), 'true', 'dictation keeps running');
  // The utterance finishes: the final text keeps the deletion.
  await page.evaluate(() => window.__say([['first words', true], ['and still being heard now', true]]));
  await settle();
  assert.equal(await value(), 'First words and still being now', 'the finished utterance keeps the deletion');

  // 2. Backspace and Delete in finished text stick, and later words are added after them.
  await page.keyboard.press('Home');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Delete');
  await settle();
  assert.equal(await value(), 'rst words and still being now', 'Delete in finished text is kept');
  await page.evaluate(() => window.__say([['first words', true], ['and still being heard now', true], ['and more', false]]));
  await settle();
  assert.equal(await value(), 'rst words and still being now and more', 'new words follow the edited text');
  await page.keyboard.press('End');
  for (let i = 0; i < 9; i++) await page.keyboard.press('Backspace');
  await settle();
  assert.equal(await value(), 'rst words and still being now', 'deleting the whole heard tail works');
  assert.equal(await mic.getAttribute('aria-pressed'), 'true', 'dictation still running after every edit');

  // 3. Selecting everything and deleting works too, and dictation keeps transcribing afterwards.
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Backspace');
  await settle();
  assert.equal(await value(), '', 'select + delete clears the box');
  await page.evaluate(() => window.__say([['first words', true], ['and still being heard now', true], ['and more', true], ['four', false]]));
  await page.waitForFunction(() => /four$/.test(document.querySelector('.composer__input').value));
  assert.equal(await mic.getAttribute('aria-pressed'), 'true', 'dictation keeps transcribing after the box was cleared');
  console.log('PASS: Backspace/Delete/selection edits work while dictating, and dictation keeps going.');
} finally {
  await browser?.close();
  child.kill();
  await stopped;
  await rm(workDir, { recursive: true, force: true });
}
