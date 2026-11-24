import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const dir = await mkdtemp(join(tmpdir(), 'marion-settings-audio-'));
const recordings = [];
const modelsUsed = [];
const prompts = [];
const spokenInputs = [];
let releaseFirstReply;
const firstReply = new Promise(resolve => { releaseFirstReply = resolve; });
const inference = createServer(async (request, response) => {
  if (request.url === '/v1/models') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'qwen-local' }, { id: 'qwen-alternate' }] }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const data = Buffer.concat(chunks);
  if (request.url === '/v1/audio/transcriptions') {
    recordings.push(data);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ text: spokenInputs.shift() ?? 'Hello from the microphone' }));
    return;
  }
  const body = JSON.parse(data.toString());
  modelsUsed.push(body.model);
  const user = body.input.filter(item => item.role === 'user').at(-1)?.content;
  prompts.push({ user, effort: body.reasoning?.effort });
  if (prompts.length === 1) await firstReply;
  const text = prompts.length === 1 ? 'This reply arrived during the follow-up.' : 'I heard you.';
  const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { output: [item], usage: { input_tokens: 1200, output_tokens: 15 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => inference.listen(0, '127.0.0.1', resolve));
const upstream = `http://127.0.0.1:${inference.address().port}/v1`;
const port = process.env.MARION_TEST_PORT || '8798';
const origin = `http://127.0.0.1:${port}`;
const mock = join(dir, 'composio.mjs');
await writeFile(mock, `
const actual = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'backend.composio.dev') {
    if (url.pathname.endsWith('/toolkits') && url.searchParams.get('limit') === '1') {
      const accepted = new Headers(init?.headers).get('x-api-key') === 'fixture_valid_project_key';
      return Promise.resolve(Response.json({}, { status: accepted ? 200 : 401 }));
    }
    throw new Error('Unexpected Composio network call in test');
  }
  return actual(input, init);
};
`);

const child = spawn(process.execPath, ['--import', mock, 'dist/index.js'], {
  cwd: process.env.MARION_TEST_RUNTIME ? join(process.env.MARION_TEST_RUNTIME, 'server') : new URL('../server/', import.meta.url),
  env: {
    ...process.env, DB_PATH: join(dir, 'test.db'),
    PORT: port, HOST: '127.0.0.1', APP_URL: origin, SERVER_URL: origin,
    DEV_LOGIN: '1', MARION_NO_SCHEDULER: '1', XAI_API_KEY: '', COMPOSIO_API_KEY: '',
    MARION_LOCAL_MODEL_URL: upstream, MARION_LOCAL_MODEL: 'qwen-local',
    MARION_STT_URL: upstream + '/audio/transcriptions',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const exit = once(child, 'exit');
let browser;
try {
  for (let i = 0; i < 60; i++) {
    if ((await fetch(origin + '/api/health').catch(() => null))?.ok) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await fetch(origin + '/api/settings/models')).status, 401);
  assert.equal((await fetch(origin + '/api/voice/status')).status, 401);
  const manifest = await fetch(origin + '/manifest.webmanifest').then(res => res.json());
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.equal((await fetch(origin + icon.src)).status, 200);

  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1410, height: 890 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.spokenReplies = [];
    if (!localStorage.getItem('marion-agent.dictationShortcut.v2')) {
      localStorage.setItem('marion-agent.dictationShortcut', 'Control+Shift+D');
    }
    window.testMicrophoneLevel = 0;
    // Drive voice activity deterministically while Chrome records from its fake microphone.
    Object.defineProperty(AnalyserNode.prototype, 'getFloatTimeDomainData', {
      value: samples => samples.fill(window.testMicrophoneLevel),
    });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window.speechSynthesis, 'getVoices', {
      value: () => [{ name: 'Test system voice', lang: 'en-US', localService: true }],
    });
    Object.defineProperty(window.speechSynthesis, 'speak', {
      value: utterance => {
        window.spokenReplies.push(utterance.text);
        setTimeout(() => utterance.onend?.(), 0);
      },
    });
  });
  await page.goto(origin);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('desktop-settings@example.com');
  await page.getByRole('button', { name: 'Continue with email' }).click();
  const composer = page.getByRole('textbox', { name: 'Message Barry' });
  await composer.waitFor();

  await page.evaluate(() => { document.documentElement.dataset.desktopWindow = 'true'; });
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const back = await settings.getByRole('button', { name: 'Back to Bots' }).boundingBox();
  assert.ok(back && back.y >= 48, 'Settings navigation should clear the native titlebar');
  await settings.getByRole('button', { name: 'Models', exact: true }).click();
  await settings.getByLabel('Default local model', { exact: true }).selectOption('qwen-alternate');
  await settings.getByRole('button', { name: 'Refresh models' }).click();
  assert.equal(await settings.getByLabel('Default local model', { exact: true }).inputValue(), 'qwen-alternate');
  await settings.getByRole('button', { name: 'Audio', exact: true }).click();
  await settings.getByRole('button', { name: 'Test microphone' }).click();
  await settings.getByText(/is available\./).waitFor();
  const sounds = settings.getByRole('checkbox', { name: 'Enable interface sounds' });
  await sounds.uncheck();
  assert.equal(await sounds.isChecked(), false);
  await settings.getByRole('button', { name: 'Shortcuts', exact: true }).click();
  await settings.getByRole('button', { name: 'Change dictation shortcut' }).getByText('Command+Shift+D').waitFor();
  await settings.getByRole('button', { name: 'Audio', exact: true }).click();
  assert.equal(await sounds.isChecked(), false);
  const selector = settings.getByLabel('Microphone input');
  const input = selector.locator('option').nth(1);
  await input.waitFor({ state: 'attached' });
  await selector.selectOption(await input.getAttribute('value'));
  if (process.env.MARION_CAPTURE_AUDIO) await page.screenshot({ path: process.env.MARION_CAPTURE_AUDIO });

  await settings.getByRole('button', { name: 'Connected apps', exact: true }).click();
  const foreign = await page.request.put(origin + '/api/settings/composio', {
    headers: { origin: 'https://other.example' }, data: { key: 'fixture_valid_project_key' },
  });
  assert.equal(foreign.status(), 403);
  const forged = await page.request.get(origin + '/api/apps/callback?slug=gmail&status=success');
  assert.match(await forged.text(), /Connection failed/);
  const key = settings.getByLabel('Composio project API key');
  await key.fill('fixture_invalid_project_key');
  await settings.getByRole('button', { name: 'Verify and save' }).click();
  await settings.getByText(/Composio rejected the project key/).waitFor();
  await key.fill('fixture_valid_project_key');
  await settings.getByRole('button', { name: 'Verify and save' }).click();
  await settings.getByText(/Project verified/).waitFor();
  assert.ok((await readFile(join(dir, 'composio.key'), 'utf8')).includes('fixture_valid_project_key'));
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'composio.key'))).mode & 0o777, 0o600);
  await settings.getByRole('button', { name: 'Remove local key' }).click();
  await settings.getByText('Local project key removed.').waitFor();
  await assert.rejects(readFile(join(dir, 'composio.key')), { code: 'ENOENT' });
  await settings.getByRole('button', { name: 'Close settings' }).click();

  const navigation = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
  await page.keyboard.press('Control+r');
  await navigation;
  await composer.waitFor();
  await page.keyboard.press('Control+k');
  const search = page.getByRole('textbox', { name: 'Search', exact: false }).last();
  await search.focus();
  await page.keyboard.press('Meta+Shift+d');
  await page.locator('.field-dictation[data-visible="true"]').getByText('Listening…').waitFor();
  await page.waitForTimeout(600);
  await page.keyboard.press('Meta+Shift+d');
  await page.waitForFunction(() => document.activeElement?.value === 'Hello from the microphone');
  await page.keyboard.press('Escape');
  const dictate = page.getByRole('button', { name: 'Dictate', exact: true });
  await dictate.click({ button: 'right' });
  const microphoneMenu = page.getByRole('menu', { name: 'Audio input' });
  await microphoneMenu.getByRole('menuitemradio', { name: 'System default' }).waitFor();
  const testMic = microphoneMenu.getByRole('menuitemradio').nth(1);
  await testMic.click();
  await page.keyboard.press('Meta+Shift+d');
  await page.getByRole('button', { name: 'Stop dictation' }).waitFor();
  await page.waitForTimeout(600);
  await page.keyboard.press('Meta+Shift+d');
  await page.waitForFunction(() => document.querySelector('.composer__input')?.value === 'Hello from the microphone');
  await composer.fill('');

  spokenInputs.push('So, basically, I want to.', 'build a project.', 'Also, make it blue.');
  await page.locator('.composer').getByRole('button', { name: 'Call Barry', exact: true }).click();
  const call = page.getByRole('region', { name: 'Call with Barry', exact: true });
  await call.getByText('Listening', { exact: true }).waitFor();
  const speak = async () => {
    await page.evaluate(() => { window.testMicrophoneLevel = 0.2; });
    await call.getByText('Listening…', { exact: true }).waitFor();
    await page.waitForTimeout(420);
    await page.evaluate(() => { window.testMicrophoneLevel = 0; });
  };
  await speak();
  await call.getByText('Listening for you to continue', { exact: true }).waitFor();
  assert.equal(prompts.length, 0, 'an unfinished thought was sent to the model');
  assert.equal(await page.locator('.bubble').count(), 0, 'an unfinished thought appeared in chat');
  await speak();
  await call.getByText('Thinking…', { exact: true }).waitFor();
  const followUp = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().endsWith('/messages')
    && response.request().postDataJSON().text === 'Also, make it blue.');
  await speak();
  assert.ok((await followUp).ok(), 'follow-up was not accepted while the first reply was pending');
  releaseFirstReply();
  await call.getByText('I heard you.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.spokenReplies), ['I heard you.']);
  assert.deepEqual(prompts, [
    { user: 'So, basically, I want to build a project.', effort: 'low' },
    { user: 'Also, make it blue.', effort: 'low' },
  ]);
  await page.getByText('qwen-alternate · 1,200 in · 15 out tokens').last().waitFor();
  await call.getByRole('button', { name: 'End call' }).click();
  await call.waitFor({ state: 'hidden' });
  await page.locator('.completion-notice[data-visible="true"]').getByText('Barry finished').waitFor();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download transcript' }).click();
  const shared = await download;
  const transcript = await readFile(await shared.path(), 'utf8');
  assert.match(transcript, /So, basically, I want to build a project/);
  assert.match(transcript, /I heard you\./);

  assert.deepEqual(modelsUsed, ['qwen-alternate', 'qwen-alternate']);
  assert.equal(recordings.length, 5);
  assert.ok(recordings.every(recording => recording.length > 1000));
  assert.deepEqual(errors, []);
  if (process.env.MARION_CAPTURE_VOICE) await page.screenshot({ path: process.env.MARION_CAPTURE_VOICE });
  console.log('PASS: app manifest, refresh, model selection, Composio key lifecycle, microphone, dictation and local voice.');

  const actions = page.getByRole('group', { name: 'Conversation actions' });
  const detailsButton = actions.getByRole('button', { name: /^(Show|Close) details$/ });
  const gap = async (left, right) => {
    const a = await left.boundingBox();
    const b = await right.boundingBox();
    assert.ok(a && b);
    return b.x - a.x - a.width;
  };
  const toolbarGap = await gap(page.getByRole('button', { name: 'Sort chats' }), page.getByRole('button', { name: 'New Bot' }));
  const shareButton = actions.getByRole('button', { name: 'Share', exact: true });
  assert.equal(await gap(shareButton, detailsButton), toolbarGap);
  if (await detailsButton.getAttribute('aria-expanded') === 'false') await detailsButton.click();
  const details = page.getByRole('complementary', { name: 'Conversation details' });
  const usage = details.locator('.context-card + .model-usage');
  await usage.getByText('Model usage', { exact: true }).waitFor();
  await usage.getByText(/Last response.*tokens/).waitFor();
  await details.evaluate(el => Promise.all(el.parentElement.getAnimations().map(animation => animation.finished)));
  assert.equal(await gap(shareButton, detailsButton), toolbarGap);
  await page.setViewportSize({ width: 1410, height: 475 });
  await details.locator('.details__scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const tabs = details.locator('.details__tabs');
  const positions = () => tabs.locator('button').evaluateAll(buttons => buttons.map(button => {
    const { x, y, width } = button.getBoundingClientRect();
    return { x, y, width };
  }));
  const activityTabs = await positions();
  for (const name of ['Tasks', 'Library', 'Activity']) {
    const tab = tabs.getByRole('button', { name, exact: true });
    await tab.click();
    assert.equal(await tab.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await positions(), activityTabs);
  }
  await page.setViewportSize({ width: 1410, height: 890 });

  let sawAudio = false;
  let ended = false;
  await page.route('**/api/voice/status', route => route.fulfill({ json: { realtime: true, localSpeech: false } }));
  await page.route('**/api/voice/session', route => route.fulfill({ json: {
    callId: 'realtime-test', clientSecret: 'fixture', websocketUrl: 'ws://127.0.0.1/realtime-fixture',
    model: 'grok-voice-latest', sampleRate: 24000, session: {},
  }}));
  await page.route('**/api/voice/end', route => { ended = true; return route.fulfill({ json: { ok: true } }); });
  await page.routeWebSocket('ws://127.0.0.1/realtime-fixture', socket => {
    socket.onMessage(message => {
      const event = JSON.parse(message);
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
      if (event.type === 'input_audio_buffer.append' && event.audio.length > 100 && !sawAudio) {
        sawAudio = true;
        socket.send(JSON.stringify({
          type: 'response.output_audio_transcript.done', item_id: 'realtime-reply', transcript: 'Realtime fixture response.',
        }));
        socket.send(JSON.stringify({
          type: 'response.done', response: {
            output: [{ id: 'realtime-reply', type: 'message', role: 'assistant' }],
            usage: { input_tokens: 120, output_tokens: 25 },
          },
        }));
      }
    });
  });
  await page.reload();
  await page.locator('.composer').getByRole('button', { name: 'Call Barry', exact: true }).click();
  const realtime = page.getByRole('region', { name: 'Voice call with Barry' });
  await realtime.getByText('Realtime fixture response.').waitFor();
  await realtime.getByText('120 in · 25 out tokens', { exact: true }).waitFor();
  for (let i = 0; i < 20 && !sawAudio; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(sawAudio, 'realtime WebSocket received no microphone PCM');
  await realtime.getByRole('button', { name: 'Mute' }).click();
  await realtime.getByRole('button', { name: 'Unmute' }).waitFor();
  await realtime.getByRole('button', { name: 'End call' }).click();
  await realtime.waitFor({ state: 'hidden' });
  for (let i = 0; i < 20 && !ended; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(ended, 'realtime call did not send an end event');
  assert.deepEqual(errors, []);
  console.log('PASS: realtime call UI, microphone PCM, mute and hangup over a simulated WebSocket.');
} finally {
  releaseFirstReply();
  await browser?.close();
  child.kill();
  await exit;
  await new Promise(resolve => inference.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
